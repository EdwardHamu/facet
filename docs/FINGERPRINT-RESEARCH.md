# 浏览器指纹功能调研

调研日期：2026-10-15。对象：v0.2.14（HEAD f884640）。只读阅读源码与文档，并运行现有指纹单元测试，未修改代码与数据。

## 1. 结论摘要

- 指纹是“实例环境”的一部分。每个实例使用独立的 Electron 会话，并保存一份环境配置：UA、语言、时区、视口与 DPR、CPU 线程、媒体偏好、地理位置，以及可选的指纹覆盖（硬件与屏幕、WebGL 字符串、Canvas、音频、元素矩形扰动）。
- 实现方式是“CDP 原生覆盖 + 页面主环境脚本改写”，没有修改浏览器内核。项目文档也说明这不代表已实现原生指纹内核。
- 每个实例由固定种子决定全部派生值，跨重启保持不变。随机方案只在用户操作时生成并完整写入实例，启动时只读取保存值，不重新抽取。

## 2. 代码位置

| 文件 | 作用 |
| --- | --- |
| src/main/fingerprint.cjs | 指纹设置校验（normalize）、方案生成（preset）、注入脚本组装（script）、UA 与 UA-CH 元数据 |
| src/main/fingerprint-catalog.cjs、fingerprint-catalog.json | 扩展设备库 library-v1 的候选池与抽取规则 |
| src/main/fingerprint-inject.js | 注入页面主环境的改写脚本模板，载荷由 script() 填入 |
| src/main/environment.cjs | 环境配置校验（environment）与运行时应用（applyEnvironment） |
| src/main/viewport.cjs | 视口与 DPR（Emulation.setDeviceMetricsOverride） |
| src/main/webrtc-policy.cjs | WebRTC 只允许经代理的 UDP |
| src/main/controller.cjs | 实例启动：独立会话、setUserAgent、读取原生 UA-CH、调用 applyEnvironment |
| tests/fingerprint.test.cjs | 13 项单元测试 |
| docs/FINGERPRINT-CATALOG.md | 候选库来源、组合规则与已知限制 |

## 3. 数据模型与取值范围

- 环境（environment.cjs）：语言（规范化后的 BCP 47）、时区（Intl 可识别）、视口宽 640 到 3840、高 480 到 2160（同时为 0 表示自适应）、缩放 1 到 3、CPU 1 到 64、UA 不超过 512 字符、平台为空或 Win32、MacIntel、Linux x86_64、配色与减少动态效果、可选经纬度。
- 指纹（fingerprint.normalize）：默认关闭；种子为 1 到 64 位字母、数字、下划线或短横线；屏幕宽 640 到 7680、高 480 到 4320，可用高度不超过屏幕高度；内存 1、2、4、8；色深 24、30、32；触点 0 到 10；开关 hardware、webgl、canvas、audio、rects；启用 WebGL 覆盖时必须提供厂商与渲染器字符串。
- 启用硬件覆盖时，视口不能超过模拟屏幕。

## 4. 方案生成

- 设备预设：6 个固定模板（NVIDIA、AMD、Intel 的 2K、1080p 与笔记本），注释说明移植自“Arena模型助手”的编译期常量。
- 随机（random）：保留当前视口、屏幕与 DPR，从候选库抽取 GPU、CPU、内存，并启用 WebGL、Canvas、音频。
- 扩展设备库整套随机（library-v1）：
  - GPU 482 条（NVIDIA 188、AMD 228、Intel 66），先等概率选厂商，再在厂商池中选型号；
  - 屏幕与 DPR 13 套，必须能容纳手动固定的视口，未固定时视口保持自适应；
  - CPU 6 到 32 共 8 档，6 或 8 线程时内存为 4 或 8 GB，其余为 8 GB；
  - 每项用 SHA-256（库标识:种子:字段名）取值，同一种子与库版本可复现；配色偏好与减少动态效果使用独立的种子标签。
- UA 统一为当前 Electron 内核对应 Chrome 版本的 Windows UA；生成的 UA 与运行内核一致时沿用原生 UA-CH 元数据，显式自定义 UA 时清空自定义 UA-CH。

## 5. 运行时应用顺序（applyEnvironment）

1. Page.addScriptToEvaluateOnNewDocument 注入指纹脚本，在每个新文档的页面脚本之前执行。
2. Emulation.setUserAgentOverride 设置 UA、Accept-Language、平台与 UA-CH 元数据；默认 UA 会去掉 Electron/版本号这一运行时标记。
3. Emulation.setTimezoneOverride 与 Emulation.setLocaleOverride 设置时区与语言区域。
4. 视口与 DPR 由 viewport.cjs 通过 Emulation.setDeviceMetricsOverride 设置。
5. Emulation.setHardwareConcurrencyOverride 设置 CPU 线程。
6. Emulation.setEmulatedMedia 设置配色与减少动态效果；启用定位时 Emulation.setGeolocationOverride 设置经纬度。

## 6. 页面脚本改写清单（fingerprint-inject.js）

| 项目 | 接口 | 方式 |
| --- | --- | --- |
| 硬件 | navigator.deviceMemory、maxTouchPoints | 原型上定义 getter |
| 屏幕 | screen.width、height、availWidth、availHeight、colorDepth、pixelDepth | 原型上定义 getter |
| Canvas | getImageData、toDataURL、toBlob | 按种子在固定步长的像素上加 1 到 3；导出时先复制画布再扰动，不改可见画布 |
| WebGL | getParameter（37445、37446） | 返回设定的厂商与渲染器字符串，WebGL1 与 WebGL2 均覆盖 |
| 音频 | AudioBuffer.getChannelData | 每个声道在种子决定的位置加 1e-8 量级微扰，只扰动一次 |
| 元素矩形 | Element 与 Range 的 getBoundingClientRect | x、y 加亚像素偏移 |

## 7. 网络侧相关

- WebRTC：所有页面强制 disable_non_proxied_udp，策略未生效时关闭该页面而不降级。它只阻止旁路 UDP，不伪造 IP。
- 代理与出口同步：由 mihomo 内核与 ip-services 等模块处理，语言与时区可按出口同步，本次未展开阅读。

## 8. 持久化与接口

- 方案字段完整写入实例环境配置；更换候选库不会自动改变已保存的实例。
- 本地控制 API 涉及 settings、fingerprint-preset（preset 可为设备预设标识、random 或 library-v1）、reset-environment、instance-reset-many。
- 重置环境会清除网站数据，并重新生成屏幕、DPR 与硬件，保留代理、名称、备注、语言、时区与定位策略。

## 9. 测试现状

- npm.cmd run test:fingerprint：13 项，本次在 Node v24.12.0 下全部通过，其中包含 2000 个种子的组合一致性检查。
- Electron 回归（test:fingerprint-electron 等）本次未运行：仓库当前没有安装 node_modules。

## 10. 已知限制

项目文档已列出：

- 字体、媒体设备、语音、WebGPU、完整 WebGL 能力与 TLS 未覆盖；
- Worker 与 OffscreenCanvas 覆盖不完整，Worker 中仍返回原生设备内存；
- 当前 Electron 44.4.5 不发送 Sec-CH-UA 请求头，HTTP Client Hints 需在内核阶段实现；
- Canvas 与音频沿用固定种子扰动，不导入第三方签名或私有算法。

阅读代码补充：

- 页面改写均为主环境中的 JavaScript 属性与方法替换，不涉及内核；脚本会设置全局标记 window.__arenaFingerprintV3Applied，辅助函数 markNative 目前不做任何处理。
- 元素矩形只覆盖 getBoundingClientRect，音频只覆盖 getChannelData，WebGL 只覆盖厂商与渲染器字符串。
- 屏幕属性在 Screen 原型上覆盖，CSS 媒体查询中的设备尺寸不受这部分脚本影响。
