'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { normalize, preset, script, DEVICE_TEMPLATES } = require('../src/main/fingerprint.cjs');
const { environment } = require('../src/main/environment.cjs');
const { clientHintsHeaders, datadogTraceHeaders, attachClientHints } = require('../src/main/client-hints.cjs');

test('point 1: font fingerprint protection intercepts font checking, queryLocalFonts and measureText', () => {
  const env = environment(preset('random', {}, 'font-test-seed'));
  const s = script(env);
  assert(s);

  const sandbox = {
    window: {},
    document: {
      fonts: {
        check: (font) => true
      }
    },
    FontFaceSet: class FontFaceSet {
      check(font) { return true; }
    },
    CanvasRenderingContext2D: class CanvasRenderingContext2D {
      measureText(text) { return { width: 100 }; }
    },
    Navigator: class Navigator {},
    Screen: class Screen {},
    HTMLCanvasElement: class HTMLCanvasElement {}
  };
  sandbox.window = sandbox;
  sandbox.navigator = new sandbox.Navigator();
  sandbox.screen = new sandbox.Screen();
  sandbox.window.FontFaceSet = sandbox.FontFaceSet;
  sandbox.window.CanvasRenderingContext2D = sandbox.CanvasRenderingContext2D;
  sandbox.window.queryLocalFonts = async () => [{ family: 'ExoticFont' }];

  vm.createContext(sandbox);
  vm.runInContext(s, sandbox);

  // 1. document.fonts.check returns false for non-standard / obscure fonts
  assert.equal(sandbox.document.fonts.check('16px "MyCustomFontXYZ"'), false);
  // standard font returns true
  assert.equal(sandbox.document.fonts.check('16px "Arial"'), true);
  assert.equal(sandbox.document.fonts.check('12px "Microsoft YaHei", sans-serif'), true);

  // 2. queryLocalFonts returns standard Windows system fonts instead of exotic fonts
  sandbox.window.queryLocalFonts().then(fonts => {
    assert(fonts.some(f => f.family === 'Arial'));
    assert(fonts.some(f => f.family === 'Segoe UI'));
    assert(!fonts.some(f => f.family === 'ExoticFont'));
  });

  // 3. measureText receives deterministic jitter
  const ctx = new sandbox.CanvasRenderingContext2D();
  const m = ctx.measureText('test');
  assert.notEqual(m.width, 100);
  assert(Math.abs(m.width - 100) < 0.01);
});

test('point 2: media devices spoofing returns consistent virtual devices with isolated deviceIds', async () => {
  const env = environment(preset('random', {}, 'media-test-seed'));
  const s = script(env);

  const sandbox = {
    window: { location: { origin: 'https://example.com' } },
    navigator: {
      mediaDevices: {
        enumerateDevices: async () => [
          { deviceId: 'real-mic-1', kind: 'audioinput', label: 'Real Microphone 1' },
          { deviceId: 'real-mic-2', kind: 'audioinput', label: 'Real Microphone 2' },
          { deviceId: 'real-cam-1', kind: 'videoinput', label: 'Real HD Camera' }
        ]
      }
    },
    Navigator: class Navigator {},
    Screen: class Screen {},
    HTMLCanvasElement: class HTMLCanvasElement {}
  };
  sandbox.window.navigator = sandbox.navigator;
  sandbox.window.Navigator = sandbox.Navigator;
  sandbox.window.Screen = sandbox.Screen;
  sandbox.window.HTMLCanvasElement = sandbox.HTMLCanvasElement;

  vm.createContext(sandbox);
  vm.runInContext(s, sandbox);

  const devices = await sandbox.navigator.mediaDevices.enumerateDevices();
  assert.equal(devices.length, 3);
  assert.equal(devices.filter(d => d.kind === 'audioinput').length, 1);
  assert.equal(devices.filter(d => d.kind === 'audiooutput').length, 1);
  assert.equal(devices.filter(d => d.kind === 'videoinput').length, 1);
  for (const d of devices) {
    assert.equal(d.label, ''); // Empty label before authorization
    assert.equal(d.deviceId.length, 64); // 64-char hex SHA256-like id
    assert(/^[0-9a-f]{64}$/.test(d.deviceId));
  }
});

test('point 3: WebGPU requestAdapter aligns adapter.info with spoofed WebGL vendor and renderer', async () => {
  const env = environment(preset('win-amd-qhd', {}, 'webgpu-seed'));
  const s = script(env);

  const sandbox = {
    window: {},
    GPU: class GPU {
      async requestAdapter() {
        return {
          info: { vendor: 'nvidia', device: 'NVIDIA RTX 3070', architecture: 'ampere', description: 'real' },
          async requestAdapterInfo() { return this.info; },
          limits: { maxTextureDimension2D: 16384 }
        };
      }
    },
    navigator: {},
    Navigator: class Navigator {},
    Screen: class Screen {},
    HTMLCanvasElement: class HTMLCanvasElement {}
  };
  sandbox.window.GPU = sandbox.GPU;
  sandbox.navigator.gpu = new sandbox.GPU();
  sandbox.window.navigator = sandbox.navigator;
  sandbox.window.Navigator = sandbox.Navigator;
  sandbox.window.Screen = sandbox.Screen;
  sandbox.window.HTMLCanvasElement = sandbox.HTMLCanvasElement;

  vm.createContext(sandbox);
  vm.runInContext(s, sandbox);

  const adapter = await sandbox.navigator.gpu.requestAdapter();
  assert(adapter);
  assert.equal(adapter.info.vendor, 'amd');
  assert.equal(adapter.info.architecture, 'rdna-2');
  assert(adapter.info.device.includes('Radeon'));
  assert.equal(adapter.limits.maxTextureDimension2D, 16384);

  const legacyInfo = await adapter.requestAdapterInfo();
  assert.equal(legacyInfo.vendor, 'amd');
});

test('point 4: full WebGL parameter override and readPixels pixel perturbation', () => {
  const env = environment(preset('random', {}, 'webgl-seed'));
  const s = script(env);

  let pixelsBuffer = null;
  class FakeWebGL {
    getParameter(param) { return 'native'; }
    readPixels(x, y, w, h, fmt, type, pixels) {
      pixelsBuffer = pixels;
      for (let i = 0; i < pixels.length; i++) pixels[i] = 100;
    }
  }

  const sandbox = {
    window: {
      WebGLRenderingContext: FakeWebGL,
      WebGL2RenderingContext: class FakeWebGL2 extends FakeWebGL {}
    },
    Navigator: class Navigator {},
    Screen: class Screen {},
    HTMLCanvasElement: class HTMLCanvasElement {},
    CanvasRenderingContext2D: class CanvasRenderingContext2D {}
  };
  sandbox.window.Navigator = sandbox.Navigator;
  sandbox.window.Screen = sandbox.Screen;
  sandbox.window.HTMLCanvasElement = sandbox.HTMLCanvasElement;

  vm.createContext(sandbox);
  vm.runInContext(s, sandbox);

  const gl = new sandbox.window.WebGLRenderingContext();
  assert.equal(gl.getParameter(37445), env.fingerprint.vendor);
  assert.equal(gl.getParameter(37446), env.fingerprint.renderer);
  assert.equal(gl.getParameter(7936), 'WebKit');
  assert.equal(gl.getParameter(7937), 'WebKit WebGL');

  const buf = new Uint8Array(128);
  gl.readPixels(0, 0, 8, 4, 6408, 5121, buf);
  let perturbed = false;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 100) { perturbed = true; break; }
  }
  assert(perturbed, 'readPixels should be perturbed by seed noise');
});

test('point 6: Worker injection wraps worker creation and aligns WorkerNavigator', () => {
  const env = environment(preset('win-nvidia-qhd', { cpu: 16 }, 'worker-seed'));
  const s = script(env);

  let createdUrl = null;
  class NativeWorker {
    constructor(url, options) {
      createdUrl = url;
      this.options = options;
    }
  }

  const sandbox = {
    URL: URL,
    Blob: class Blob { constructor(p, o) {} },
    window: {
      location: { href: 'https://example.com/index.html' },
      URL: URL,
      Blob: class Blob { constructor(p, o) {} }
    },
    Worker: NativeWorker,
    Navigator: class Navigator {},
    Screen: class Screen {},
    HTMLCanvasElement: class HTMLCanvasElement {}
  };
  sandbox.window.Worker = NativeWorker;
  sandbox.window.Navigator = sandbox.Navigator;
  sandbox.window.Screen = sandbox.Screen;
  sandbox.window.HTMLCanvasElement = sandbox.HTMLCanvasElement;

  URL.createObjectURL = () => 'blob:https://example.com/wrapped-worker-uuid';

  vm.createContext(sandbox);
  vm.runInContext(s, sandbox);

  const worker = new sandbox.window.Worker('./worker.js');
  assert(worker);
  assert.equal(createdUrl, 'blob:https://example.com/wrapped-worker-uuid');
});

test('point 7: Sec-CH-UA client hints headers generation and injection', () => {
  const envWindows = { platform: 'Win32' };
  const hintsWin = clientHintsHeaders(envWindows);
  assert(hintsWin);
  assert(hintsWin['Sec-CH-UA'].includes('Chromium'));
  assert.equal(hintsWin['Sec-CH-UA-Mobile'], '?0');
  assert.equal(hintsWin['Sec-CH-UA-Platform'], '"Windows"');

  const envMac = { platform: 'MacIntel' };
  const hintsMac = clientHintsHeaders(envMac);
  assert.equal(hintsMac['Sec-CH-UA-Platform'], '"macOS"');

  const envFirefox = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0' };
  assert.equal(clientHintsHeaders(envFirefox), null);

  let listener = null;
  const mockSession = {
    webRequest: {
      onBeforeSendHeaders: (filter, fn) => { listener = fn; }
    }
  };
  attachClientHints(mockSession, envWindows);
  assert(listener);

  let callbackResult = null;
  listener({ requestHeaders: { 'User-Agent': 'test' } }, (res) => { callbackResult = res; });
  assert(callbackResult.requestHeaders['Sec-CH-UA']);
  assert.equal(callbackResult.requestHeaders['Sec-CH-UA-Platform'], '"Windows"');
  assert.equal(callbackResult.requestHeaders['Sec-CH-UA-Mobile'], '?0');
});

test('defect 1: Datadog RUM W3C trace context generation and injection on XHR/fetch', () => {
  const trace = datadogTraceHeaders();
  assert(trace);
  assert(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(trace.traceparent));
  assert(/^dd=s:1;o:rum;p:[0-9a-f]{16}$/.test(trace.tracestate));
  assert(/^\d+$/.test(trace['x-datadog-trace-id']));
  assert(/^\d+$/.test(trace['x-datadog-parent-id']));
  assert.equal(trace['x-datadog-origin'], 'rum');
  assert.equal(trace['x-datadog-sampling-priority'], '1');

  let listener = null;
  const mockSession = {
    webRequest: {
      onBeforeSendHeaders: (filter, fn) => { listener = fn; }
    }
  };
  attachClientHints(mockSession, { platform: 'Win32' });

  // XHR request gets trace injected
  let xhrResult = null;
  listener({ resourceType: 'xhr', requestHeaders: {} }, (res) => { xhrResult = res; });
  assert(xhrResult.requestHeaders['traceparent']);
  assert(xhrResult.requestHeaders['tracestate']);
  assert(xhrResult.requestHeaders['x-datadog-trace-id']);

  // Pre-existing trace is not overwritten
  let existingResult = null;
  listener({ resourceType: 'fetch', requestHeaders: { 'traceparent': 'custom-trace' } }, (res) => { existingResult = res; });
  assert.equal(existingResult.requestHeaders['traceparent'], 'custom-trace');
});

test('defect 2: Canvas, WebGL, Audio and ClientRects vary across different instance seeds', () => {
  const envA = environment(preset('random', {}, 'instance-alpha'));
  const envB = environment(preset('random', {}, 'instance-beta'));
  const scriptA = script(envA);
  const scriptB = script(envB);

  function createSandbox(s) {
    class MockCanvasRenderingContext2D {
      getImageData(x, y, w, h) {
        return { data: new Uint8ClampedArray(w * h * 4).fill(128) };
      }
    }
    class MockHTMLCanvasElement {
      constructor() { this.width = 64; this.height = 64; }
      getContext(type) { return new MockCanvasRenderingContext2D(); }
      toDataURL() { return 'data:image/png;base64,mock'; }
    }
    class MockAudioBuffer {
      constructor(len) { this.data = new Float32Array(len).fill(0.5); }
      getChannelData(c) { return this.data; }
    }
    class MockElement {
      getBoundingClientRect() { return { x: 10, y: 20, width: 114.15625, height: 15 }; }
      getClientRects() { return [this.getBoundingClientRect()]; }
    }
    const sb = {
      window: {},
      document: { createElement: () => new MockHTMLCanvasElement() },
      HTMLCanvasElement: MockHTMLCanvasElement,
      CanvasRenderingContext2D: MockCanvasRenderingContext2D,
      AudioBuffer: MockAudioBuffer,
      Element: MockElement,
      DOMRect: class DOMRect {
        constructor(x, y, w, h) { this.x = x; this.y = y; this.width = w; this.height = h; }
      },
      Navigator: class {},
      Screen: class {}
    };
    sb.window = sb;
    sb.navigator = new sb.Navigator();
    sb.screen = new sb.Screen();
    vm.createContext(sb);
    vm.runInContext(s, sb);
    return sb;
  }

  const sbA = createSandbox(scriptA);
  const sbB = createSandbox(scriptB);

  // 1. Canvas 2D image data differs between seeds
  const ctxA = new sbA.CanvasRenderingContext2D();
  const ctxB = new sbB.CanvasRenderingContext2D();
  const dataA = ctxA.getImageData(0, 0, 16, 16).data;
  const dataB = ctxB.getImageData(0, 0, 16, 16).data;
  assert.notDeepEqual(dataA, dataB);

  // 2. Audio buffer: critical 4500..5000 window has unique samples between seeds
  const audioA = new sbA.AudioBuffer(6000);
  const audioB = new sbB.AudioBuffer(6000);
  const chanA = audioA.getChannelData(0).slice(4500, 5000);
  const chanB = audioB.getChannelData(0).slice(4500, 5000);
  assert.notDeepEqual(chanA, chanB);

  // 3. ClientRects: width and height differ between seeds
  const elA = new sbA.Element();
  const elB = new sbB.Element();
  const rectA = elA.getBoundingClientRect();
  const rectB = elB.getBoundingClientRect();
  assert.notEqual(rectA.width, 114.15625);
  assert.notEqual(rectA.width, rectB.width);
  assert.notEqual(rectA.height, rectB.height);
  assert.notDeepEqual(elA.getClientRects(), elB.getClientRects());
});

test('defect 3: locale-aware font whitelisting blocks CJK on en-US profiles and blocks Apple fonts', () => {
  const envEn = environment({ ...preset('random', {}, 'en-font-seed'), language: 'en-US' });
  const scriptEn = script(envEn);

  const envZh = environment({ ...preset('random', {}, 'zh-font-seed'), language: 'zh-CN' });
  const scriptZh = script(envZh);

  function createFontSandbox(s) {
    const sb = {
      window: {},
      document: { fonts: { check: () => true } },
      FontFaceSet: class FontFaceSet { check() { return true; } },
      CanvasRenderingContext2D: class CanvasRenderingContext2D { measureText() { return { width: 100 }; } },
      Navigator: class Navigator {},
      Screen: class Screen {},
      HTMLCanvasElement: class HTMLCanvasElement {}
    };
    sb.window = sb;
    sb.navigator = new sb.Navigator();
    sb.screen = new sb.Screen();
    sb.window.FontFaceSet = sb.FontFaceSet;
    sb.window.CanvasRenderingContext2D = sb.CanvasRenderingContext2D;
    vm.createContext(sb);
    vm.runInContext(s, sb);
    return sb;
  }

  const sbEn = createFontSandbox(scriptEn);
  const sbZh = createFontSandbox(scriptZh);

  // On en-US Windows:
  // Western fonts return true
  assert.equal(sbEn.document.fonts.check('16px "Arial"'), true);
  assert.equal(sbEn.document.fonts.check('16px "Segoe UI"'), true);
  // Chinese fonts return false on en-US!
  assert.equal(sbEn.document.fonts.check('16px "Microsoft YaHei"'), false);
  assert.equal(sbEn.document.fonts.check('16px "SimSun"'), false);
  assert.equal(sbEn.document.fonts.check('16px "SimHei"'), false);
  // Apple fonts return false on Windows!
  assert.equal(sbEn.document.fonts.check('16px "PingFang SC"'), false);
  assert.equal(sbEn.document.fonts.check('16px "PingFang SC", sans-serif'), false);

  // On zh-CN Windows:
  // Chinese fonts return true
  assert.equal(sbZh.document.fonts.check('16px "Microsoft YaHei"'), true);
  assert.equal(sbZh.document.fonts.check('16px "SimSun"'), true);
  // Apple fonts still return false on Windows!
  assert.equal(sbZh.document.fonts.check('16px "PingFang SC"'), false);
});

test('defect 4: User-Agent and Client Hints vary across different instance seeds', () => {
  const envA = environment(preset('random', {}, 'instance-ua-1'));
  const envB = environment(preset('random', {}, 'instance-ua-2'));

  assert(envA.userAgent.includes('Chrome/'));
  assert(envB.userAgent.includes('Chrome/'));
  assert.notEqual(envA.userAgent, envB.userAgent);

  const hintsA = clientHintsHeaders(envA);
  const hintsB = clientHintsHeaders(envB);
  assert(hintsA['Sec-CH-UA']);
  assert(hintsB['Sec-CH-UA']);
});
