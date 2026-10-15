# 千面（facet）指纹覆盖完善技术报告

本文档记录针对《指纹覆盖缺失.md》所提出的七项指纹维度在千面（facet）中的技术完善方案与实现落地。

## 一、方案设计概览

| 维度 | 缺失特征 | 防护机制 | 落地模块 |
| --- | --- | --- | --- |
| 1. 字体探测 | 页面通过 `document.fonts.check`、`queryLocalFonts`、Canvas `measureText` 探测本机安装字体列表 | 系统标准字体白名单过滤 + 未安装字体回退 + 基于种子的文字排版微扰 | `src/main/fingerprint-inject.js` |
| 2. 媒体设备 | `navigator.mediaDevices.enumerateDevices` 暴露真实麦克风、扬声器、摄像头数量及特征 | 跨源隔离但同源内由固定种子决定的标准虚拟音视频设备列表（1 输入/1 输出/1 视频） | `src/main/fingerprint-inject.js` |
| 3. WebGPU | `navigator.gpu.requestAdapter` 报告真实显卡（如 AMD WebGL 与 NVIDIA WebGPU 矛盾） | 代理拦截 `adapter.info` 与 `requestAdapterInfo`，对齐 vendor、architecture、device 与 WebGL 显卡一致 | `src/main/fingerprint-inject.js` |
| 4. 完整 WebGL | 仅改写厂商/渲染器字符串，未覆盖参数；`readPixels` 读回真实渲染图像哈希 | 扩展 `getParameter` 参数；在 `readPixels` 阶段对像素缓冲区注入基于种子的噪点微扰 | `src/main/fingerprint-inject.js` |
| 5. TLS 指纹 | 网络层 HTTPS 握手报文 ClientHello 特征共用 Chromium 网络栈 | 分析网络协议栈边界；直连保持 Chromium/BoringSSL 同源标准特征；代理模式协同 Mihomo 内核 uTLS 特征 | `docs/FINGERPRINT-COVERAGE.md` |
| 6. Worker 一致性 | Worker 线程内 `deviceMemory` 与 `OffscreenCanvas` 仍返回本机真实值 | 劫持 `window.Worker` 与 `SharedWorker`，在 Worker 作用域前置注入 `WorkerNavigator` 与 `OffscreenCanvas` 补丁 | `src/main/fingerprint-inject.js` |
| 7. Sec-CH-UA 请求头 | 网页环境伪装成 Chrome 但网络层 HTTP 请求头缺失 `Sec-CH-UA*` 客户端提示 | 实例会话级别监听 `session.webRequest.onBeforeSendHeaders`，按实例版本自动补齐 Client Hints | `src/main/client-hints.cjs`、`src/main/controller.cjs` |

---

## 二、详细实现说明

### 1. 字体指纹探测防护（Fonts）
- **检测原理**：主流指纹检测脚本（如 FingerprintJS、CreepJS）通过 `document.fonts.check()`、`window.queryLocalFonts()` 以及创建隐藏 DOM/Canvas 测量字形渲染宽度（`measureText`），推测用户操作系统安装的专有字体与办公软件。
- **防护措施**：
  1. 维护一份包含 Windows 标准出厂字体的集合（Arial, Calibri, Consolas, Courier New, Microsoft YaHei, Segoe UI, Times New Roman, Verdana 等）。
  2. 拦截 `document.fonts.check` 与 `FontFaceSet.prototype.check`：对于非标准字体一律返回 `false`（模拟字体未安装）。
  3. 拦截 `window.queryLocalFonts`：返回标准系统字体列表，阻断本地全部安装字体枚举。
  4. 拦截 `CanvasRenderingContext2D.prototype.measureText`：非系统字体回退测量，并结合实例固定种子 `fp.FontsSeed` 在 `TextMetrics.width` 上施加确定性亚像素微扰（1e-4 量级），破坏文字排版哈希。

### 2. 媒体设备枚举伪装（Media Devices）
- **检测原理**：`navigator.mediaDevices.enumerateDevices()` 在未获授权时虽不返回设备标签（label），但会报告麦克风、摄像头和扬声器的准确数量和类型，构成强指纹维度。
- **防护措施**：
  1. 拦截 `enumerateDevices()`，统一返回包含 1 个 `audioinput`、1 个 `audiooutput`、1 个 `videoinput` 的标准虚拟设备集合。
  2. 每个设备的 `deviceId` 和 `groupId` 由 `(实例种子:站点Origin:设备类型:序号)` 经 SHA-256 派生为 64 字符十六进制串，确保同源稳定、跨源隔离且各实例独立。
  3. 未授权时 `label` 保持空字符串，完全符合 W3C 媒体设备规范。

### 3. WebGPU 显卡适配器对齐（WebGPU）
- **检测原理**：现代页面通过 `navigator.gpu.requestAdapter()` 查询 `adapter.info`（`vendor`, `architecture`, `device`, `description`），若千面 WebGL 伪装成 AMD，而 WebGPU 仍报告真实 NVIDIA 显卡，将产生直接逻辑冲突。
- **防护措施**：
  1. 拦截 `GPU.prototype.requestAdapter`，获取底层原生适配器后返回安全代理（Proxy）。
  2. 将 `adapter.info` 和 `adapter.requestAdapterInfo()` 拦截并映射为与 `fp.WebGlVendor` 和 `fp.WebGlRenderer` 一致的参数：
     - AMD 显卡：`vendor: "amd"`, `architecture: "rdna-2"`, `device: "AMD Radeon ..."`
     - NVIDIA 显卡：`vendor: "nvidia"`, `architecture: "ampere"`, `device: "NVIDIA GeForce ..."`
     - Intel 显卡：`vendor: "intel"`, `architecture: "gen-12"`, `device: "Intel Iris ..."`
  3. 其他硬件限制（`limits`）与计算管道正常透传，保证 WebGPU 应用兼容性。

### 4. 完整 WebGL 参数与绘制防哈希（WebGL & readPixels）
- **检测原理**：指纹脚本在 Canvas/WebGL 中绘制复杂图形、光影与着色器，调用 `gl.readPixels()` 读回像素并计算哈希，以此提取硬件图形管道与浮点计算的微小物理差异。
- **防护措施**：
  1. 扩展 `getParameter`：不仅拦截 37445（UNMASKED_VENDOR）与 37446（UNMASKED_RENDERER），同时将 7936（VENDOR）和 7937（RENDERER）规范化为 Chromium 标准值 `'WebKit'` / `'WebKit WebGL'`。
  2. 拦截 `WebGLRenderingContext.prototype.readPixels` 与 `WebGL2RenderingContext.prototype.readPixels`：在像素读出后，针对 TypedArray 按照实例种子 `fp.CanvasSeed` 注入步长微扰，破坏真实 GPU 绘图哈希，使每个实例拥有独立且跨会话稳定的 WebGL 画布指纹。

### 5. TLS 网络层指纹与代理协同（TLS Fingerprint）
- **架构分析**：
  - TLS ClientHello 握手报文由 Chromium 底层 BoringSSL 网络栈发出，包含 Cipher Suites、Extensions 顺序、Supported Groups、ALPN 及 GREASE 字段，运行在网络服务进程中，网页 JavaScript 无法拦截改写。
  - 在直连模式下，Electron 内核版本（Chromium 134）发出的 ClientHello 报文本身即为原生的 Google Chrome 真实 TLS 指纹。
  - 在代理模式下，facet 将实例网络接入独立的内置 Mihomo（Clash Meta）内核，Mihomo 上游连接支持基于 uTLS 的 Chrome 客户端指纹模拟，实现了从链路层到应用层的指纹特征协同。

### 6. Worker 环境一致性（Worker Scope Injection）
- **检测原理**：Worker 线程运行在 `WorkerGlobalScope`，拥有独立的 `WorkerNavigator`。常规主世界 CDP 注入无法触及 Worker，导致 Worker 中读到的 `deviceMemory` 与 `hardwareConcurrency` 为本机真实物理值。
- **防护措施**：
  1. 在主环境劫持 `window.Worker` 与 `window.SharedWorker` 构造函数。
  2. 动态封装构造脚本，通过轻量级 Blob URL 在 Worker 脚本最前置执行内联补丁：
     - 覆盖 `WorkerNavigator.prototype.deviceMemory` 与 `hardwareConcurrency`；
     - 覆盖 `OffscreenCanvasRenderingContext2D.prototype.getImageData`；
     - 覆盖 `OffscreenCanvas` 创建的 WebGL/WebGL2 上下文的 `getParameter` 与 `readPixels`。
  3. 保留原型链并提供原生降级容错，确保主页面与多线程环境读取的设备参数 100% 严格一致。

### 7. Sec-CH-UA 客户端提示请求头（Client Hints）
- **检测原理**：真正的 Chrome 发出的 HTTP/HTTPS 请求头中携带 `Sec-CH-UA`、`Sec-CH-UA-Mobile`、`Sec-CH-UA-Platform`。Electron 默认未完整发送这些头，导致服务器端识别出“UA 声称是 Chrome，网络层却没有 Client Hints”。
- **防护措施**：
  1. 在 `src/main/client-hints.cjs` 中根据实例的平台（Windows / macOS / Linux）及 Chrome 内核主版本号构造标准结构化请求头。
  2. 在 `src/main/controller.cjs` 中为每个实例会话安装 `session.webRequest.onBeforeSendHeaders` 拦截器。
  3. 对所有发往外部的 HTTP/HTTPS 请求自动补全缺失的 `Sec-CH-UA` 请求头，若用户配置了非 Chromium UA（如 Firefox）则自动保持空缺，与客户端规范完全对齐。

---

## 三、验证与测试

1. **语法与边界检查**：
   - 运行 `node scripts/check.cjs`：全部 238 个主进程与渲染脚本语法和沙盒边界校验通过。
2. **指纹核心回归测试**：
   - 运行 `node --test tests/fingerprint.test.cjs`：13 项核心测试全部通过，2000 个随机种子一致性校验无回退。
3. **七项新维度专用测试**：
   - 在 `tests/fingerprint-coverage.test.cjs` 中覆盖字体探测拦截、媒体设备虚拟化、WebGPU 适配器对齐、WebGL readPixels 像素微扰、Worker 注入包装、Sec-CH-UA 客户端提示生成与网络拦截，全部通过。
