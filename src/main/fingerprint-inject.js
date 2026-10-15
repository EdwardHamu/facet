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
  /* ---------------- Canvas 噪声 ----------------
   * 种子决定步长与增量，同一实例跨会话恒定。
   * 注意 toDataURL / toBlob 走「离屏副本」路径：必须先克隆再写噪点，
   * 否则会把噪点写回用户可见的画布，页面自己看得出来。            */
  var noisePixels = function (data, seed) {
    if (!data || data.length < 4) return data;
    var step = Math.max(4, Math.floor(data.length / 32 / 4) * 4);
    var delta = (Math.abs(seed) % 3) + 1;
    var start = Math.abs(seed) % Math.max(1, Math.min(step, data.length - 3));
    for (var i = start; i < data.length; i += step) {
      var p = i - (i % 4);
      data[p] = (data[p] + delta) & 255;
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
      var copy = document.createElement("canvas");
      copy.width = self.width;
      copy.height = self.height;
      var ctx = copy.getContext("2d");
      ctx.drawImage(self, 0, 0);
      var image = originalImageData.call(ctx, 0, 0, copy.width, copy.height);
      noisePixels(image.data, fp.CanvasSeed);
      ctx.putImageData(image, 0, 0);
      return copy;
    };

    var originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = markNative(function () {
      try { return originalToDataURL.apply(cloneWithNoise(this), arguments); }
      catch (e) { return originalToDataURL.apply(this, arguments); }
    }, originalToDataURL);

    var originalToBlob = HTMLCanvasElement.prototype.toBlob;
    if (originalToBlob) {
      HTMLCanvasElement.prototype.toBlob = markNative(function (callback) {
        try {
          var args = Array.prototype.slice.call(arguments, 1);
          return originalToBlob.call(cloneWithNoise(this), callback, ...args);
        } catch (e) { return originalToBlob.apply(this, arguments); }
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
          if (pixels && pixels.length) noisePixels(pixels, fp.CanvasSeed);
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
   * 拦截 document.fonts.check 与 queryLocalFonts，对非标准系统字体返回 false/空；
   * 并在 measureText 中针对非系统标准字体回退为通用字体，结合种子对宽度施加微扰，
   * 阻断基于字体枚举与排版尺寸对比推测本机软件/字体列表。 */
  if (fp.Fonts || fp.Hardware) {
    try {
      var standardFonts = [
        "arial", "arial black", "calibri", "cambria", "cambria math", "comic sans ms",
        "consolas", "courier", "courier new", "georgia", "impact", "lucida console",
        "lucida sans unicode", "microsoft sans serif", "microsoft yahei", "ms gothic",
        "ms pgothic", "ms sans serif", "ms serif", "palatino linotype", "segoe print",
        "segoe script", "segoe ui", "segoe ui symbol", "simsun", "tahoma", "times new roman",
        "trebuchet ms", "verdana", "yu gothic"
      ];
      var isStandardFont = function (fontSpec) {
        if (!fontSpec || typeof fontSpec !== "string") return true;
        var fontLower = fontSpec.toLowerCase().replace(/['"]/g, "");
        for (var i = 0; i < standardFonts.length; i++) {
          if (fontLower.indexOf(standardFonts[i]) !== -1) return true;
        }
        return false;
      };
      if (document.fonts && document.fonts.check) {
        var origFontCheck = document.fonts.check;
        document.fonts.check = markNative(function (font, text) {
          if (!isStandardFont(font)) return false;
          return origFontCheck.apply(this, arguments);
        }, origFontCheck);
      }
      if (window.FontFaceSet && FontFaceSet.prototype.check) {
        var origFontFaceCheck = FontFaceSet.prototype.check;
        FontFaceSet.prototype.check = markNative(function (font, text) {
          if (!isStandardFont(font)) return false;
          return origFontFaceCheck.apply(this, arguments);
        }, origFontFaceCheck);
      }
      if (window.queryLocalFonts) {
        window.queryLocalFonts = markNative(function () {
          var list = [
            { family: "Arial", fullName: "Arial", postscriptName: "ArialMT", style: "Regular" },
            { family: "Calibri", fullName: "Calibri", postscriptName: "Calibri", style: "Regular" },
            { family: "Consolas", fullName: "Consolas", postscriptName: "Consolas", style: "Regular" },
            { family: "Courier New", fullName: "Courier New", postscriptName: "CourierNewPSMT", style: "Regular" },
            { family: "Microsoft YaHei", fullName: "Microsoft YaHei", postscriptName: "MicrosoftYaHei", style: "Regular" },
            { family: "Segoe UI", fullName: "Segoe UI", postscriptName: "SegoeUI", style: "Regular" },
            { family: "Times New Roman", fullName: "Times New Roman", postscriptName: "TimesNewRomanPSMT", style: "Regular" },
            { family: "Verdana", fullName: "Verdana", postscriptName: "Verdana", style: "Regular" }
          ];
          return Promise.resolve(list);
        });
      }
      if (window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype.measureText) {
        var origMeasureText = CanvasRenderingContext2D.prototype.measureText;
        var fontJitter = ((Math.abs(fp.FontsSeed || 0) % 7) - 3) * 0.0001;
        CanvasRenderingContext2D.prototype.measureText = markNative(function (text) {
          var metrics = origMeasureText.apply(this, arguments);
          if (metrics && typeof metrics.width === "number" && fontJitter !== 0) {
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
   * 单点微扰 1e-8 量级：足以改变浮点摘要，不足以让听感或波形分析察觉。 */
  if (fp.Audio) try {
    if (window.AudioBuffer && AudioBuffer.prototype.getChannelData) {
      var originalAudio = AudioBuffer.prototype.getChannelData;
      var touched = new WeakMap();
      AudioBuffer.prototype.getChannelData = markNative(function () {
        var data = originalAudio.apply(this, arguments);
        var channels = touched.get(this);
        if (!channels) { channels = new Set(); touched.set(this, channels); }
        if (data && !channels.has(Number(arguments[0])) && data.length) {
          channels.add(Number(arguments[0]));
          var index = Math.abs(fp.AudioSeed) % data.length;
          data[index] = data[index] + (((Math.abs(fp.AudioSeed) % 11) + 1) * 1e-8);
        }
        return data;
      }, originalAudio);
    }
  } catch (e) {}

  /* ---------------- 元素盒模型微扰 ----------------
   * 亚像素级偏移，破坏 getBoundingClientRect 的精确指纹，
   * 又不至于影响布局判定（各站点阈值通常远大于 1e-5）。 */
  var rectNoise = ((Math.abs(fp.ClientRectsSeed) % 9) + 1) * 0.00001;
  var cloneRect = function (r) {
    try { return new DOMRect(r.x + rectNoise, r.y + rectNoise, r.width, r.height); }
    catch (e) { return r; }
  };
  if (fp.Rects) try {
    var originalRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = markNative(function () {
      return cloneRect(originalRect.apply(this, arguments));
    }, originalRect);
  } catch (e) {}
  if (fp.Rects) try {
    if (window.Range && Range.prototype.getBoundingClientRect) {
      var originalRangeRect = Range.prototype.getBoundingClientRect;
      Range.prototype.getBoundingClientRect = markNative(function () {
        return cloneRect(originalRangeRect.apply(this, arguments));
      }, originalRangeRect);
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
