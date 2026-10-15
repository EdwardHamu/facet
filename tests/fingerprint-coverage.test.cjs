'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { normalize, preset, script, DEVICE_TEMPLATES } = require('../src/main/fingerprint.cjs');
const { environment } = require('../src/main/environment.cjs');
const { clientHintsHeaders, attachClientHints } = require('../src/main/client-hints.cjs');

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

