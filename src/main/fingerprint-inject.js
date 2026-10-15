// Adapted from the read-only fingerprint reference. Optional main-world patches; not complete hardware emulation.
(function () {
  if (window.__arenaFingerprintV3Applied) return;
  window.__arenaFingerprintV3Applied = true;

  var fp = /*__FACET_FP_PAYLOAD__*/null;
  if (!fp || typeof fp !== "object") return;

  var markNative = function(replacement) { return replacement; };

  var define = function (obj, key, value) {
    try {
      var old = Object.getOwnPropertyDescriptor(obj, key);
      var getter = function () { return value; };
      Object.defineProperty(obj, key, {
        get: getter, configurable: true, enumerable: old ? old.enumerable : false,
      });
    } catch (e) {}
  };

  var value = function (obj, key, val) {
    try { define(obj, key, val); } catch (e) {}
  };

  // Language, timezone, UA, CPU and DPR belong exclusively to native CDP overrides.
  if (fp.Hardware) {
    define(Navigator.prototype, "deviceMemory", fp.DeviceMemory);
    define(Navigator.prototype, "maxTouchPoints", fp.MaxTouchPoints);
    define(Screen.prototype, "width", fp.ScreenWidth);
    define(Screen.prototype, "height", fp.ScreenHeight);
    define(Screen.prototype, "availWidth", fp.ScreenWidth);
    define(Screen.prototype, "availHeight", fp.AvailableScreenHeight);
    define(Screen.prototype, "colorDepth", fp.ColorDepth);
    define(Screen.prototype, "pixelDepth", fp.ColorDepth);
  }

  /* ---------------- Canvas / WebGL 像素噪点 ----------------
   * 采用高熵 32 位伪随机数发生器，根据种子对像素多通道实施亚感知离散微扰，
   * 彻底避免同步长单通道偏移导致的指纹特征重合。
   * 注意 toDataURL / toBlob 走「离屏副本」路径：必须先克隆再写噪点，
   * 否则会把噪点写回用户可见的画布，页面自己看得出来。 */
  var noisePixels = function (data, seed) {
    if (!data || data.length < 4) return data;
    var s = (Math.abs(seed) || 135792468) >>> 0;
    var nextRand = function () {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return s;
    };
    var len = data.length;
    var step = Math.max(4, Math.floor(len / 64 / 4) * 4);
    var start = (nextRand() % 8) * 4;
    for (var i = start; i < len; i += step) {
      var r = nextRand();
      var ch = r & 3;
      if (ch === 3) ch = 0; // 保护 Alpha 通道不失真
      var delta = ((r >>> 2) % 5) - 2; // -2, -1, 0, 1, 2
      if (delta === 0) delta = (r & 1) ? 1 : -1;
      var idx = i + ch;
      if (idx < len) {
        var val = data[idx] + delta;
        data[idx] = val < 0 ? 0 : (val > 255 ? 255 : val);
      }
    }
    return data;
  };

  if (fp.Canvas) try {
    var originalImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = markNative(function () {
      var result = originalImageData.apply(this, arguments);
      if (result && result.data) noisePixels(result.data, fp.CanvasSeed);
      return result;
    }, originalImageData);

    var cloneWithNoise = function (self) {
      try {
        var copy = document.createElement("canvas");
        copy.width = self.width;
        copy.height = self.height;
        var ctx = copy.getContext("2d");
        if (!ctx) return self;
        ctx.drawImage(self, 0, 0);
        var image = originalImageData.call(ctx, 0, 0, copy.width, copy.height);
        if (image && image.data) {
          noisePixels(image.data, fp.CanvasSeed || fp.WebGlSeed || 1);
          ctx.putImageData(image, 0, 0);
          return copy;
        }
      } catch (e) {}
      return self;
    };

    var originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = markNative(function () {
      try {
        var noisy = cloneWithNoise(this);
        if (noisy) return originalToDataURL.apply(noisy, arguments);
      } catch (e) {}
      return originalToDataURL.apply(this, arguments);
    }, originalToDataURL);

    var originalToBlob = HTMLCanvasElement.prototype.toBlob;
    if (originalToBlob) {
      HTMLCanvasElement.prototype.toBlob = markNative(function (callback) {
        try {
          var noisy = cloneWithNoise(this);
          var args = Array.prototype.slice.call(arguments, 1);
          return originalToBlob.call(noisy || this, callback, ...args);
        } catch (e) {
          return originalToBlob.apply(this, arguments);
        }
      }, originalToBlob);
    }
  } catch (e) {}

  /* ---------------- WebGL vendor / renderer & readPixels ----------------
   * 37445 = UNMASKED_VENDOR_WEBGL, 37446 = UNMASKED_RENDERER_WEBGL。
   * 这两个常量即使不取 debug_renderer_info 扩展也会被直接查询，
   * 所以必须在 getParameter 入口拦截，不能只改扩展返回。
   * 同时拦截 readPixels，在像素读回阶段注入基于种子的噪点，阻断 WebGL 画布哈希追踪。 */
  var patchWebGl = function (Type) {
    try {
      if (!Type) return;
      var original = Type.prototype.getParameter;
      Type.prototype.getParameter = markNative(function (parameter) {
        if (parameter === 37445 && fp.WebGlVendor) return fp.WebGlVendor;
        if (parameter === 37446 && fp.WebGlRenderer) return fp.WebGlRenderer;
        if (parameter === 7936) return "WebKit";
        if (parameter === 7937) return "WebKit WebGL";
        return original.apply(this, arguments);
      }, original);
      if (fp.Canvas && Type.prototype.readPixels) {
        var originalReadPixels = Type.prototype.readPixels;
        Type.prototype.readPixels = markNative(function (x, y, w, h, fmt, type, pixels) {
          originalReadPixels.apply(this, arguments);
          if (pixels && pixels.length) noisePixels(pixels, fp.CanvasSeed || fp.WebGlSeed || 1);
        }, originalReadPixels);
      }
    } catch (e) {}
  };
  if (fp.WebGL) { patchWebGl(window.WebGLRenderingContext); patchWebGl(window.WebGL2RenderingContext); }

  /* ---------------- WebGPU 适配器对齐 ----------------
   * navigator.gpu.requestAdapter 返回的 GPUAdapterInfo 与 WebGL 显卡对齐，
   * 避免出现 WebGL 伪装 AMD 而 WebGPU 报告真实 NVIDIA 的硬件冲突。 */
  if ((fp.WebGL || fp.WebGPU) && window.GPU && GPU.prototype.requestAdapter) {
    try {
      var origRequestAdapter = GPU.prototype.requestAdapter;
      var detectGpuInfo = function () {
        var vendorStr = String(fp.WebGlVendor || "");
        var rendStr = String(fp.WebGlRenderer || "");
        var v = "google";
        var arch = "";
        if (/nvidia/i.test(vendorStr) || /nvidia/i.test(rendStr)) {
          v = "nvidia";
          arch = "ampere";
        } else if (/amd/i.test(vendorStr) || /amd|radeon/i.test(rendStr)) {
          v = "amd";
          arch = "rdna-2";
        } else if (/intel/i.test(vendorStr) || /intel/i.test(rendStr)) {
          v = "intel";
          arch = "gen-12";
        }
        var match = rendStr.match(/ANGLE \([^,]+,\s*([^)]*?)(?:\s+Direct3D|\))/i);
        var dev = match ? match[1].trim() : (rendStr || "Graphics");
        return { vendor: v, architecture: arch, device: dev, description: rendStr };
      };
      var targetGpuInfo = detectGpuInfo();
      GPU.prototype.requestAdapter = markNative(function () {
        return origRequestAdapter.apply(this, arguments).then(function (adapter) {
          if (!adapter) return adapter;
          return new Proxy(adapter, {
            get: function (target, prop, receiver) {
              if (prop === "info") return targetGpuInfo;
              if (prop === "requestAdapterInfo") {
                return markNative(function () { return Promise.resolve(targetGpuInfo); });
              }
              var val = Reflect.get(target, prop, target);
              if (typeof val === "function") return val.bind(target);
              return val;
            }
          });
        });
      }, origRequestAdapter);
    } catch (e) {}
  }

  /* ---------------- 媒体设备枚举伪装 ----------------
   * 拦截 navigator.mediaDevices.enumerateDevices，未授权时返回
   * 跨源隔离但同源内由种子决定的标准虚拟音视频设备列表（1 输入/1 输出/1 视频），
   * 避免暴露本机真实外设数量与种类。 */
  if ((fp.Media || fp.Hardware) && window.navigator && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    try {
      var origEnumerateDevices = navigator.mediaDevices.enumerateDevices;
      navigator.mediaDevices.enumerateDevices = markNative(function () {
        var origin = "";
        try { origin = window.location.origin || ""; } catch (err) {}
        var hash = function (str) {
          var h = 0;
          for (var i = 0; i < str.length; i++) {
            h = ((h << 5) - h) + str.charCodeAt(i);
            h |= 0;
          }
          return ("00000000" + Math.abs(h).toString(16)).slice(-8);
        };
        var makeId = function (kind, idx) {
          var s = (fp.Seed || "facet") + ":" + origin + ":" + kind + ":" + idx;
          return hash(s + ":1") + hash(s + ":2") + hash(s + ":3") + hash(s + ":4") +
                 hash(s + ":5") + hash(s + ":6") + hash(s + ":7") + hash(s + ":8");
        };
        var gid = hash((fp.Seed || "facet") + ":" + origin + ":group");
        var mockDevices = [
          { deviceId: makeId("audioinput", 0), kind: "audioinput", label: "", groupId: gid },
          { deviceId: makeId("audiooutput", 0), kind: "audiooutput", label: "", groupId: gid },
          { deviceId: makeId("videoinput", 0), kind: "videoinput", label: "", groupId: gid }
        ];
        return Promise.resolve(mockDevices);
      }, origEnumerateDevices);
    } catch (e) {}
  }

  /* ---------------- 字体指纹探测防护 ----------------
   * 拦截 document.fonts.check 与 queryLocalFonts，根据环境语言（Language）动态过滤：
   * 1. 英文/西方配置严禁泄露 CJK 中日韩字体（如 SimSun, Microsoft YaHei, Meiryo 等）；
   * 2. Windows 平台坚决屏蔽 macOS/iOS 专属字体（如 PingFang SC, Apple Color Emoji）；
   * 3. 严格解析 CSS 字体规范提取主字体名称，防止 ", sans-serif" 兜底后缀绕过白名单。 */
  if (fp.Fonts || fp.Hardware) {
    try {
      var lang = String(fp.Language || "").toLowerCase();
      var isChineseLocale = lang.indexOf("zh") === 0;
      var isJapaneseLocale = lang.indexOf("ja") === 0;
      var isKoreanLocale = lang.indexOf("ko") === 0;

      // Windows 基础通用英文标准字体（所有 Windows 安装版本 100% 自带）
      var standardWesternFonts = [
        "arial", "arial black", "calibri", "cambria", "cambria math", "comic sans ms",
        "consolas", "courier", "courier new", "georgia", "impact", "lucida console",
        "lucida sans unicode", "microsoft sans serif", "palatino linotype", "segoe print",
        "segoe script", "segoe ui", "segoe ui symbol", "tahoma", "times new roman",
        "trebuchet ms", "verdana"
      ];

      var allowedFonts = standardWesternFonts.slice();
      if (isChineseLocale) {
        allowedFonts.push("microsoft yahei", "simsun", "simhei", "kaiti", "fangsong", "dengxian");
      } else if (isJapaneseLocale) {
        allowedFonts.push("ms gothic", "ms pgothic", "yu gothic", "meiryo");
      } else if (isKoreanLocale) {
        allowedFonts.push("malgun gothic", "gulim", "batang", "dotum");
      }

      // Apple 专属字体在 Windows 下永远非法
      var appleFonts = [
        "pingfang", "pingfang sc", "pingfang tc", "pingfang hk", "noto sans cjk",
        "apple color emoji", "san francisco", "helvetica", "helvetica neue",
        "menlo", "monaco", "sf pro", "sf mono"
      ];

      // 提取被测主字体（剥离字号、字重以及兜底 fallback 如 , sans-serif）
      var extractPrimaryFont = function (fontSpec) {
        if (!fontSpec || typeof fontSpec !== "string") return "";
        var clean = fontSpec.replace(/^\s*(?:(?:italic|oblique|small-caps|bold|bolder|lighter|\d+)\s+)*(?:\d+(?:\.\d+)?(?:px|pt|em|rem|%)\s*(?:\/\s*\d+(?:\.\d+)?(?:px|pt|em|rem|%)?)?\s+)/i, "").trim();
        var primary = clean.split(",")[0].trim().replace(/^['"]|['"]$/g, "").toLowerCase();
        return primary;
      };

      var isAllowedFont = function (fontSpec) {
        var primary = extractPrimaryFont(fontSpec);
        if (!primary) return true;
        // 通用族系永远合法
        if (primary === "sans-serif" || primary === "serif" || primary === "monospace" || primary === "cursive" || primary === "fantasy" || primary === "system-ui") {
          return true;
        }
        // Windows 平台严防 Apple 专属字体泄露
        for (var a = 0; a < appleFonts.length; a++) {
          if (primary.indexOf(appleFonts[a]) !== -1) return false;
        }
        // 比对当前语言环境下允许的系统标准字体
        for (var i = 0; i < allowedFonts.length; i++) {
          if (primary === allowedFonts[i] || primary.indexOf(allowedFonts[i]) !== -1) return true;
        }
        return false;
      };

      if (document.fonts && document.fonts.check) {
        var origFontCheck = document.fonts.check;
        document.fonts.check = markNative(function (font, text) {
          if (!isAllowedFont(font)) return false;
          return origFontCheck.apply(this, arguments);
        }, origFontCheck);
      }
      if (window.FontFaceSet && FontFaceSet.prototype.check) {
        var origFontFaceCheck = FontFaceSet.prototype.check;
        FontFaceSet.prototype.check = markNative(function (font, text) {
          if (!isAllowedFont(font)) return false;
          return origFontFaceCheck.apply(this, arguments);
        }, origFontFaceCheck);
      }

      var FONT_PROFILES = {
        "arial": { family: "Arial", postscriptName: "ArialMT" },
        "arial black": { family: "Arial Black", postscriptName: "Arial-Black" },
        "calibri": { family: "Calibri", postscriptName: "Calibri" },
        "cambria": { family: "Cambria", postscriptName: "Cambria" },
        "cambria math": { family: "Cambria Math", postscriptName: "CambriaMath" },
        "comic sans ms": { family: "Comic Sans MS", postscriptName: "ComicSansMS" },
        "consolas": { family: "Consolas", postscriptName: "Consolas" },
        "courier": { family: "Courier", postscriptName: "Courier" },
        "courier new": { family: "Courier New", postscriptName: "CourierNewPSMT" },
        "georgia": { family: "Georgia", postscriptName: "Georgia" },
        "impact": { family: "Impact", postscriptName: "Impact" },
        "lucida console": { family: "Lucida Console", postscriptName: "LucidaConsole" },
        "lucida sans unicode": { family: "Lucida Sans Unicode", postscriptName: "LucidaSansUnicode" },
        "microsoft sans serif": { family: "Microsoft Sans Serif", postscriptName: "MicrosoftSansSerif" },
        "palatino linotype": { family: "Palatino Linotype", postscriptName: "PalatinoLinotype" },
        "segoe print": { family: "Segoe Print", postscriptName: "SegoePrint" },
        "segoe script": { family: "Segoe Script", postscriptName: "SegoeScript" },
        "segoe ui": { family: "Segoe UI", postscriptName: "SegoeUI" },
        "segoe ui symbol": { family: "Segoe UI Symbol", postscriptName: "SegoeUISymbol" },
        "tahoma": { family: "Tahoma", postscriptName: "Tahoma" },
        "times new roman": { family: "Times New Roman", postscriptName: "TimesNewRomanPSMT" },
        "trebuchet ms": { family: "Trebuchet MS", postscriptName: "TrebuchetMS" },
        "verdana": { family: "Verdana", postscriptName: "Verdana" },
        "microsoft yahei": { family: "Microsoft YaHei", postscriptName: "MicrosoftYaHei" },
        "simsun": { family: "SimSun", postscriptName: "SimSun" },
        "simhei": { family: "SimHei", postscriptName: "SimHei" },
        "kaiti": { family: "KaiTi", postscriptName: "KaiTi" },
        "fangsong": { family: "FangSong", postscriptName: "FangSong" },
        "dengxian": { family: "DengXian", postscriptName: "DengXian" },
        "ms gothic": { family: "MS Gothic", postscriptName: "MSGothic" },
        "ms pgothic": { family: "MS PGothic", postscriptName: "MSPGothic" },
        "yu gothic": { family: "Yu Gothic", postscriptName: "YuGothic" },
        "meiryo": { family: "Meiryo", postscriptName: "Meiryo" },
        "malgun gothic": { family: "Malgun Gothic", postscriptName: "MalgunGothic" },
        "gulim": { family: "Gulim", postscriptName: "Gulim" },
        "batang": { family: "Batang", postscriptName: "Batang" },
        "dotum": { family: "Dotum", postscriptName: "Dotum" }
      };
      if (window.queryLocalFonts) {
        window.queryLocalFonts = markNative(function () {
          var list = allowedFonts.map(function (f) {
            var info = FONT_PROFILES[f] || { family: f, postscriptName: f.replace(/\s+/g, "") };
            return { family: info.family, fullName: info.family, postscriptName: info.postscriptName, style: "Regular" };
          });
          return Promise.resolve(list);
        }, window.queryLocalFonts);
      }

      if (window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype.measureText) {
        var origMeasureText = CanvasRenderingContext2D.prototype.measureText;
        var fontSeed = (Math.abs(fp.FontsSeed || 0) || 54321) >>> 0;
        var fontJitter = ((((fontSeed % 5) + 1) * ((fontSeed & 1) ? 1 : -1)) * 0.0002);
        CanvasRenderingContext2D.prototype.measureText = markNative(function (text) {
          var metrics = origMeasureText.apply(this, arguments);
          if (metrics && typeof metrics.width === "number") {
            try {
              var w = metrics.width + fontJitter;
              return new Proxy(metrics, {
                get: function (target, prop) {
                  if (prop === "width") return w;
                  var val = Reflect.get(target, prop, target);
                  return typeof val === "function" ? val.bind(target) : val;
                }
              });
            } catch (err) {}
          }
          return metrics;
        }, origMeasureText);
      }
    } catch (e) {}
  }

  /* ---------------- Audio 指纹 ----------------
   * 对音频缓冲区进行均匀亚耳听阈微扰（1e-7 ~ 1e-8 量级），
   * 既能彻底打破 4500..5000 及全频段时域/频域哈希，又完全不会影响声音播放听感。 */
  if (fp.Audio) try {
    var audioSeedVal = (Math.abs(fp.AudioSeed || 0) || 987654321) >>> 0;
    if (window.AudioBuffer && AudioBuffer.prototype.getChannelData) {
      var originalAudio = AudioBuffer.prototype.getChannelData;
      var touched = new WeakMap();
      AudioBuffer.prototype.getChannelData = markNative(function () {
        var data = originalAudio.apply(this, arguments);
        var channels = touched.get(this);
        if (!channels) { channels = new Set(); touched.set(this, channels); }
        var chNum = Number(arguments[0]) || 0;
        if (data && !channels.has(chNum) && data.length) {
          channels.add(chNum);
          var s = (audioSeedVal + chNum * 7919) >>> 0;
          var nextAudioRand = function () {
            s = (Math.imul(1664525, s) + 1013904223) >>> 0;
            return s;
          };
          var len = data.length;
          // 覆盖整个采样窗口，以固定步长微扰采样点
          var step = Math.max(8, Math.min(64, Math.floor(len / 128)));
          var offset = nextAudioRand() % step;
          for (var i = offset; i < len; i += step) {
            var r = nextAudioRand();
            var jitter = (((r % 9) - 4) || 1) * 1e-7;
            data[i] = data[i] + jitter;
          }
        }
        return data;
      }, originalAudio);
    }
    if (window.AnalyserNode && AnalyserNode.prototype.getFloatFrequencyData) {
      var origGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = markNative(function (array) {
        origGetFloatFreq.apply(this, arguments);
        if (array && array.length) {
          var s = (audioSeedVal ^ 0x5a5a5a5a) >>> 0;
          for (var i = 0; i < array.length; i += 8) {
            s = (Math.imul(1664525, s) + 1013904223) >>> 0;
            array[i] += (((s % 7) - 3) * 0.001);
          }
        }
      }, origGetFloatFreq);
    }
  } catch (e) {}

  /* ---------------- 元素盒模型微扰 ----------------
   * 亚像素级微扰 x, y, width, height，同时拦截 getBoundingClientRect 与 getClientRects，
   * 破坏以 114.15625x15 等文字排版或盒模型尺寸为特征的 DOM 指纹，
   * 扰动量控制在 1e-4 量级，对人眼与页面布局完全无影响。 */
  var rectSeedVal = (Math.abs(fp.ClientRectsSeed || 0) || 13579) >>> 0;
  var rectNoiseX = (((rectSeedVal % 9) + 1) * 0.00002);
  var rectNoiseY = ((((rectSeedVal >>> 4) % 9) + 1) * 0.00002);
  var rectNoiseW = ((((rectSeedVal >>> 8) % 7) - 3) || 1) * 0.00003;
  var rectNoiseH = ((((rectSeedVal >>> 12) % 7) - 3) || 1) * 0.00003;

  var cloneRect = function (r) {
    if (!r) return r;
    try {
      var w = typeof r.width === "number" ? Math.max(0, r.width + rectNoiseW) : r.width;
      var h = typeof r.height === "number" ? Math.max(0, r.height + rectNoiseH) : r.height;
      return new DOMRect(r.x + rectNoiseX, r.y + rectNoiseY, w, h);
    } catch (e) {
      return r;
    }
  };

  if (fp.Rects) try {
    var originalRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = markNative(function () {
      return cloneRect(originalRect.apply(this, arguments));
    }, originalRect);

    var origGetClientRects = Element.prototype.getClientRects;
    if (origGetClientRects) {
      Element.prototype.getClientRects = markNative(function () {
        var list = origGetClientRects.apply(this, arguments);
        if (!list) return list;
        var arr = [];
        for (var i = 0; i < list.length; i++) {
          arr.push(cloneRect(list[i]));
        }
        return arr;
      }, origGetClientRects);
    }
  } catch (e) {}

  if (fp.Rects) try {
    if (window.Range && Range.prototype.getBoundingClientRect) {
      var originalRangeRect = Range.prototype.getBoundingClientRect;
      Range.prototype.getBoundingClientRect = markNative(function () {
        return cloneRect(originalRangeRect.apply(this, arguments));
      }, originalRangeRect);
    }
    if (window.Range && Range.prototype.getClientRects) {
      var originalRangeRects = Range.prototype.getClientRects;
      Range.prototype.getClientRects = markNative(function () {
        var list = originalRangeRects.apply(this, arguments);
        if (!list) return list;
        var arr = [];
        for (var i = 0; i < list.length; i++) {
          arr.push(cloneRect(list[i]));
        }
        return arr;
      }, originalRangeRects);
    }
  } catch (e) {}

  /* ---------------- Worker 环境一致性 ----------------
   * 劫持 window.Worker 与 SharedWorker 构造函数，向 WorkerGlobalScope
   * 注入轻量补丁，对齐 WorkerNavigator (deviceMemory, hardwareConcurrency)
   * 与 OffscreenCanvas (2D / WebGL) 的噪声扰动，消除主线程与后台线程差异。 */
  if (window.Worker && fp.Hardware) {
    try {
      var origWorker = window.Worker;
      var workerPatchScript = [
        "(function() {",
        "  if (self.__facetWorkerInjected) return;",
        "  self.__facetWorkerInjected = true;",
        "  var fp = " + JSON.stringify({
             Hardware: fp.Hardware,
             DeviceMemory: fp.DeviceMemory,
             HardwareConcurrency: fp.HardwareConcurrency,
             Canvas: fp.Canvas,
             CanvasSeed: fp.CanvasSeed,
             WebGL: fp.WebGL,
             WebGlVendor: fp.WebGlVendor,
             WebGlRenderer: fp.WebGlRenderer
           }) + ";",
        "  if (fp.Hardware && self.WorkerNavigator) {",
        "    try {",
        "      Object.defineProperty(WorkerNavigator.prototype, \"deviceMemory\", { get: function() { return fp.DeviceMemory; }, configurable: true });",
        "      Object.defineProperty(WorkerNavigator.prototype, \"hardwareConcurrency\", { get: function() { return fp.HardwareConcurrency; }, configurable: true });",
        "    } catch(e) {}",
        "  }",
        "  var noise = " + noisePixels.toString() + ";",
        "  if (self.OffscreenCanvas) {",
        "    if (fp.Canvas && self.OffscreenCanvasRenderingContext2D) {",
        "      try {",
        "        var origImgData = OffscreenCanvasRenderingContext2D.prototype.getImageData;",
        "        OffscreenCanvasRenderingContext2D.prototype.getImageData = function() {",
        "          var res = origImgData.apply(this, arguments);",
        "          if (res && res.data) noise(res.data, fp.CanvasSeed);",
        "          return res;",
        "        };",
        "      } catch(e) {}",
        "    }",
        "    if (fp.WebGL) {",
        "      var patchGl = function(Type) {",
        "        if (!Type) return;",
        "        var origGetParam = Type.prototype.getParameter;",
        "        Type.prototype.getParameter = function(p) {",
        "          if (p === 37445 && fp.WebGlVendor) return fp.WebGlVendor;",
        "          if (p === 37446 && fp.WebGlRenderer) return fp.WebGlRenderer;",
        "          if (p === 7936) return \"WebKit\";",
        "          if (p === 7937) return \"WebKit WebGL\";",
        "          return origGetParam.apply(this, arguments);",
        "        };",
        "        if (fp.Canvas && Type.prototype.readPixels) {",
        "          var origRead = Type.prototype.readPixels;",
        "          Type.prototype.readPixels = function(x, y, w, h, fmt, type, pixels) {",
        "            origRead.apply(this, arguments);",
        "            if (pixels && pixels.length) noise(pixels, fp.CanvasSeed);",
        "          };",
        "        }",
        "      };",
        "      if (self.WebGLRenderingContext) patchGl(self.WebGLRenderingContext);",
        "      if (self.WebGL2RenderingContext) patchGl(self.WebGL2RenderingContext);",
        "    }",
        "  }",
        "})();"
      ].join("\n");

      var buildWorkerUrl = function (scriptURL, isModule) {
        if (typeof scriptURL !== "string" && !(scriptURL instanceof URL)) return scriptURL;
        var fullURL = new URL(scriptURL, window.location.href).href;
        if (isModule) {
          var moduleCode = workerPatchScript + "\nimport " + JSON.stringify(fullURL) + ";";
          return URL.createObjectURL(new Blob([moduleCode], { type: "application/javascript" }));
        }
        var classicCode = workerPatchScript + "\nimportScripts(" + JSON.stringify(fullURL) + ");";
        return URL.createObjectURL(new Blob([classicCode], { type: "application/javascript" }));
      };

      window.Worker = markNative(function (scriptURL, options) {
        try {
          var isModule = options && options.type === "module";
          var wrappedURL = buildWorkerUrl(scriptURL, isModule);
          return new origWorker(wrappedURL, options);
        } catch (err) {
          return new origWorker(scriptURL, options);
        }
      }, origWorker);
      window.Worker.prototype = origWorker.prototype;

      if (window.SharedWorker) {
        var origSharedWorker = window.SharedWorker;
        window.SharedWorker = markNative(function (scriptURL, options) {
          try {
            var isModule = typeof options === "object" && options !== null && options.type === "module";
            var wrappedURL = buildWorkerUrl(scriptURL, isModule);
            return new origSharedWorker(wrappedURL, options);
          } catch (err) {
            return new origSharedWorker(scriptURL, options);
          }
        }, origSharedWorker);
        window.SharedWorker.prototype = origSharedWorker.prototype;
      }
    } catch (e) {}
  }

})();
