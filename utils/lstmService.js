/**
 * @file lstmService.js
 * @description Auto-start and lifecycle management for the Python LSTM
 * FastAPI microservice.
 *
 * When LSTM_AUTO_START=true (default), this module:
 *   1. Probes http://localhost:8000/api/v1/vousfin/health on server boot
 *   2. If the service is not running, spawns the Python process using the
 *      venv interpreter inside the LSTM project directory
 *   3. Waits up to 20 s for the service to become ready
 *   4. Logs all Python stdout/stderr via the Winston logger
 *   5. Cleans up the child process on Node.js SIGTERM / SIGINT
 *
 * If auto-start is disabled or the Python process fails, vousFin falls back
 * gracefully to Holt's Double Exponential Smoothing (no crash, no data loss).
 */

const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');

// Lazy-load the logger so this module can be required before logger is configured
let _logger;
function getLogger() {
  if (!_logger) {
    try {
      _logger = require('../config/logger');
    } catch {
      // Fallback to console if Winston logger is not yet available
      _logger = {
        info:  (...a) => console.log('[lstmService]', ...a),
        warn:  (...a) => console.warn('[lstmService]', ...a),
        error: (...a) => console.error('[lstmService]', ...a),
      };
    }
  }
  return _logger;
}

// ── Config ─────────────────────────────────────────────────────────────────────
const LSTM_API_URL   = process.env.LSTM_API_URL   || 'http://localhost:8000';
const LSTM_AUTO_START = (process.env.LSTM_AUTO_START || 'true') !== 'false';

// LSTM project directory — relative to the backend root OR absolute via env var
const BACKEND_ROOT = path.join(__dirname, '..');
const LSTM_DIR     = process.env.LSTM_DIR
  ? path.resolve(BACKEND_ROOT, process.env.LSTM_DIR)
  : path.join(BACKEND_ROOT, '..', 'workspacelstm_extracted', 'home', 'user', 'financial-lstm');

// Python executable: prefer the venv interpreter (Windows + Linux/Mac)
const VENV_PYTHON_WIN  = path.join(LSTM_DIR, 'venv', 'Scripts', 'python.exe');
const VENV_PYTHON_UNIX = path.join(LSTM_DIR, 'venv', 'bin', 'python');
const API_SCRIPT       = path.join(LSTM_DIR, 'api', 'main.py');

function _getPythonExe() {
  if (fs.existsSync(VENV_PYTHON_WIN))  return VENV_PYTHON_WIN;
  if (fs.existsSync(VENV_PYTHON_UNIX)) return VENV_PYTHON_UNIX;
  return 'python';   // system Python as last resort
}

// ── State ──────────────────────────────────────────────────────────────────────
let _lstmProcess = null;
let _isStarting  = false;
let _isReady     = false;

// ── Health probe ───────────────────────────────────────────────────────────────
async function _probe(timeoutMs = 2500) {
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
    const res  = await fetch(`${LSTM_API_URL}/api/v1/vousfin/health`,
                             { signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) return false;
    const body = await res.json();
    return body.ready === true;
  } catch {
    return false;
  }
}

// ── Wait loop ─────────────────────────────────────────────────────────────────
async function _waitReady(maxSeconds = 20) {
  const log = getLogger();
  for (let i = 0; i < maxSeconds; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const ok = await _probe();
    if (ok) {
      _isReady = true;
      log.info(`✅ Python LSTM service ready (${i + 1}s)`);
      return true;
    }
    if (i === 9) log.info('⏳ Still waiting for LSTM service...');
  }
  return false;
}

// ── Spawn ─────────────────────────────────────────────────────────────────────
function _spawn() {
  const log     = getLogger();
  const pythonExe = _getPythonExe();
  log.info(`🐍 Spawning LSTM service: ${pythonExe} ${API_SCRIPT}`);
  log.info(`   Working dir: ${LSTM_DIR}`);

  _lstmProcess = spawn(pythonExe, [API_SCRIPT], {
    cwd:      LSTM_DIR,
    stdio:    'pipe',
    detached: false,
    env:      { ...process.env },   // inherit all env vars (PORT, DEBUG, etc.)
  });

  _lstmProcess.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach(l => { if (l) getLogger().info(`[LSTM-py] ${l}`); });
  });

  _lstmProcess.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach(l => {
      if (!l) return;
      // TF/Keras info messages come on stderr — only warn on actual errors
      if (/error|critical|exception/i.test(l)) {
        getLogger().warn(`[LSTM-py] ${l}`);
      } else {
        getLogger().info(`[LSTM-py] ${l}`);
      }
    });
  });

  _lstmProcess.on('error', (err) => {
    getLogger().error(`[LSTM-py] Failed to start: ${err.message}`);
    _lstmProcess = null;
    _isStarting  = false;
    _isReady     = false;
  });

  _lstmProcess.on('exit', (code, signal) => {
    getLogger().warn(`[LSTM-py] Process exited (code=${code}, signal=${signal})`);
    _lstmProcess = null;
    _isStarting  = false;
    _isReady     = false;
  });
}

// ── Public: ensure service is running ─────────────────────────────────────────
/**
 * Called once during server.js bootstrap.
 * Probes the Python service; if not running and LSTM_AUTO_START=true,
 * spawns it and waits up to 20 seconds for readiness.
 */
async function ensureLSTMRunning() {
  const log = getLogger();

  if (!LSTM_AUTO_START) {
    log.info('ℹ️  LSTM_AUTO_START=false — skipping Python service auto-start');
    return;
  }

  if (_isStarting) {
    log.info('ℹ️  LSTM service is already starting — skipping duplicate call');
    return;
  }

  // Check if already alive
  const alive = await _probe();
  if (alive) {
    _isReady = true;
    log.info('🤖 Python LSTM service already running and ready');
    return;
  }

  // Validate prerequisites
  if (!fs.existsSync(LSTM_DIR)) {
    log.warn(`⚠️  LSTM_DIR not found: ${LSTM_DIR}`);
    log.warn('   Set LSTM_DIR in .env pointing to the financial-lstm folder');
    return;
  }
  if (!fs.existsSync(API_SCRIPT)) {
    log.warn(`⚠️  LSTM api/main.py not found at ${API_SCRIPT}`);
    return;
  }
  // Check if a trained model exists
  const modelsDir = path.join(LSTM_DIR, 'models');
  const hasModel  = fs.existsSync(modelsDir) &&
    fs.readdirSync(modelsDir).some(f => f.startsWith('model_'));
  if (!hasModel) {
    log.warn('⚠️  No trained LSTM model found in models/');
    log.warn('   Run: python run_train.py  inside the financial-lstm directory first');
    log.warn('   Falling back to Holt\'s Exponential Smoothing for all forecasts');
    return;
  }

  _isStarting = true;
  _spawn();

  const ready = await _waitReady(20);
  _isStarting = false;

  if (!ready) {
    log.warn('⚠️  LSTM service did not become ready in 20 s — Holt\'s fallback will be used');
  }
}

// ── Public: stop the service ───────────────────────────────────────────────────
function stopLSTM() {
  if (_lstmProcess) {
    getLogger().info('Stopping Python LSTM service...');
    _lstmProcess.kill('SIGTERM');
    _lstmProcess = null;
    _isReady     = false;
  }
}

// ── Public: status ─────────────────────────────────────────────────────────────
function lstmStatus() {
  return {
    running:    _lstmProcess !== null,
    ready:      _isReady,
    starting:   _isStarting,
    lstmDir:    LSTM_DIR,
    apiUrl:     LSTM_API_URL,
    autoStart:  LSTM_AUTO_START,
  };
}

module.exports = { ensureLSTMRunning, stopLSTM, lstmStatus };
