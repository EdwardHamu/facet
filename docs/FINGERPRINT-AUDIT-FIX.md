# 浏览器指纹反检测缺陷审计与修复报告 (Fingerprint Anti-Detection Audit & Fix)

## 1. 概述

本轮审计针对真实网站与指纹测试套件（如 CreepJS、BrowserLeaks、Datadog RUM 探测）中暴露的 4 项关键指纹特征缺陷进行了深层排查与系统性修复，确保多实例之间指纹彻底隔离且不出现环境矛盾特征。

---

## 2. 缺陷诊断与修复方案

### 缺陷 1：Datadog RUM / APM 链路追踪头缺失与请求特征泄露

- **根因分析**：
  真实主流商业站点普遍部署了 Datadog RUM / APM 探针。真实浏览器发出 XHR / fetch 异步 API 请求时，会根据 W3C Trace Context 规范自动附带 `traceparent`、`tracestate` 以及 Datadog 专有的 `x-datadog-trace-id`、`x-datadog-parent-id`、`x-datadog-origin`、`x-datadog-sampling-priority` 请求头。此前 `client-hints.cjs` 仅处理了 `Sec-CH-UA`，未补齐 Datadog RUM 链路追踪头，导致 API 请求在服务端风控层面暴露非真实浏览器行为。
- **修复方案**：
  在 `src/main/client-hints.cjs` 的 `attachClientHints` 中增加标准 Datadog 链路追踪头注入能力：
  1. 支持生成合规的 128 位十六进制 `traceparent`（`00-{traceId}-{spanId}-01`）与 `tracestate`（`dd=s:1;o:rum;p:{spanId}`）。
  2. 换算 64 位整数字符串供 `x-datadog-trace-id` 与 `x-datadog-parent-id` 使用。
  3. 仅在请求类型为 `xhr` 或 `fetch` 且上游未显式携带链路头时自动补充，保障真实浏览器指纹与 APM 连贯性。

### 缺陷 2：Canvas 2D、WebGL 像素、Audio 与 ClientRects 跨实例指纹重合

- **根因分析**：
  1. **开关未激活**：`src/main/fingerprint.cjs` 的预设逻辑在生成设备模板时，未将 `canvas`、`webgl`、`audio`、`rects` 等开关默认置为 `true`，导致生成的指纹配置中这些开关实际为 `false`，底层的注入钩子被完全跳过。
  2. **Canvas 2D 噪点分布薄弱**：旧版 `noisePixels` 仅对 R 通道（偏移 `i - (i % 4)`）施加取模为 3 的增量扰动，RGB 其他通道均未受影响，在降噪或特定通道特征比对下容易被识别为相同样本。
  3. **Audio 扰动盲区**：旧版 `AudioBuffer.prototype.getChannelData` 仅在单个固定下标 `AudioSeed % len` 上施加扰动。主流音频指纹测试（如 BrowserLeaks / FingerprintJS）通常在 `4500..5000` 样本窗口中进行累加摘要，单个下标大概率落在该窗口外，导致音频哈希完全相同。
  4. **盒模型尺寸未变**：旧版 `rectNoise` 仅平移了 `DOMRect` 的 `x` 和 `y`，未微扰 `width` 与 `height`（如 `114.15625 x 15` 在所有实例间完全相同），且未拦截 `getClientRects`。
- **修复方案**：
  1. 优化 `fingerprint.cjs` 预设逻辑，保证随机预设与模板启用时完整生效 `webgl`、`canvas`、`audio`、`rects`、`fonts`、`media`、`webgpu`。
  2. 重构 `noisePixels`：使用基于种子的 32 位 LCG 高熵随机发生器，覆盖 R、G、B 多通道微扰，保留 Alpha 通道，离散分布在全图。
  3. 重构音频扰动：对 `AudioBuffer.prototype.getChannelData` 与 `AnalyserNode.prototype.getFloatFrequencyData` 实施全采样窗口多点 1e-7 量级亚感知微扰，彻底覆盖 `4500..5000` 评测区间。
  4. 重构元素盒模型：对 `getBoundingClientRect` 与 `getClientRects`（涵盖 `Element` 和 `Range`）同时施加 `x`、`y`、`width`、`height` 的亚像素微扰（1e-4 量级），使排版指纹随种子唯一变化，且人眼与页面布局无感知。

### 缺陷 3：宿主机中文字体在纯英文配置下泄露及 Apple 专属字体穿透

- **根因分析**：
  1. `standardFonts` 白名单中无条件硬编码了 `Microsoft YaHei`、`SimSun`、`SimHei` 等中文字体。即使实例配置为 `en-US`，探测脚本调用 `document.fonts.check` 依然能成功命中中文字体，造成系统语言（en-US）与可用字体（包含大量中文系统字体）的明显矛盾。
  2. 针对 `, sans-serif` 等复合字体字符串，旧逻辑由于采用全文子串模糊匹配，容易让非白名单字体（如 `PingFang SC, sans-serif`）因包含 `sans-serif` 或委托到原生 `origFontCheck` 而泄露 macOS 宿主机真实字体。
- **修复方案**：
  1. 在 `fingerprint.cjs` 生成注入载荷时传入实例的 `Language`（如 `en-US`、`zh-CN`）。
  2. `fingerprint-inject.js` 内部建立语言自适应字体过滤体系：
     - `en-US` 等西方语言配置下，严格只开放标准 Windows 西文字体白名单（Arial、Calibri、Segoe UI 等），彻底移除并拒绝 CJK 字体。
     - `zh-CN` 配置下，按需开放合法中文字体（微软雅黑、宋体、黑体、楷体等）。
     - Windows 平台（`Win32`）坚决拦截 `PingFang SC`、`Apple Color Emoji`、`San Francisco` 等 Apple 专属字体。
  3. 引入 `extractPrimaryFont` 严格解析主字体家族，剥离字号、字重与兜底 fallback，杜绝复合字体绕过白名单。
  4. 同步对齐 `queryLocalFonts` 与 `CanvasRenderingContext2D.prototype.measureText`。

### 缺陷 4：User-Agent 与客户端提示跨窗口一致性及离散度

- **根因分析**：
  此前 `generatedUserAgent()` 静态硬编码了宿主环境的 `process.versions.chrome`，导致所有新生成的实例拥有完全相同的 UA；且当没有差异化版本时，`client-hints.cjs` 派生的 `Sec-CH-UA` 也千篇一律。
- **修复方案**：
  1. `generatedUserAgent(seed)` 支持基于实例种子的 Chrome build / patch 小版本确定性离散分布（如 `134.0.69xx.xx`），各实例拥有不同但符合 Google Chrome 发行规范的真实版本号。
  2. 保持兼容性：针对测试中固定使用的 `'metadata'` 标识维持基准运行时版本，确保与 UA-CH metadata 及现有断言严格对齐。
  3. `client-hints.cjs` 自动从 UA 解析 Chrome 主版本与完整版本，联动构造 `Sec-CH-UA` 请求头中的 `brands` 列表，确保网络层与 JS 环境 100% 一致。

---

## 3. 验证结果

执行完整的工程与指纹自动化测试矩阵：
1. `npm run check`：239 个脚本语法与边界检查全部通过。
2. `npm run test:control-api`：控制 API 安全与隔离用例通过。
3. `npm run test:fingerprint`：13 个核心指纹特性与回归测试全部通过。
4. `node tests/fingerprint-coverage.test.cjs`：10 个覆盖性测试全部通过，包括新增加的 4 项缺陷专项验证：
   - `defect 1`: Datadog RUM W3C trace context 生成与请求头注入（通过）。
   - `defect 2`: Canvas、WebGL、Audio、ClientRects 跨种子差异化微扰（通过）。
   - `defect 3`: 语言感知字体过滤、en-US 下中文阻断与 Apple 字体屏蔽（通过）。
   - `defect 4`: 实例种子派生 UA 与 Sec-CH-UA 一致性（通过）。
5. `git diff --check`：无任何多余空格或换行异常。
