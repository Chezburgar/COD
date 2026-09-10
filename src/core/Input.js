/* Input — pointer lock, keys, mouse deltas and wheel, with rebindable actions. */

export const DEFAULT_BINDS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  sprint: ['ShiftLeft'],
  slide: ['KeyC'],
  reload: ['KeyR'],
  melee: ['KeyV'],
  frag: ['KeyG'],
  tactical: ['KeyQ'],
  inspect: ['KeyF'],
  slot1: ['Digit1'],
  slot2: ['Digit2'],
  slot3: ['Digit3'],
  swap: ['KeyX'],
  scoreboard: ['Tab'],
  firemode: ['KeyB'],
  killstreak1: ['Digit4'],
  killstreak2: ['Digit5'],
};

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.mouse = { dx: 0, dy: 0, wheel: 0 };
    this.buttons = [false, false, false];
    this.buttonsPressed = [false, false, false];
    this.locked = false;
    this.binds = { ...DEFAULT_BINDS };
    this.sensitivity = 1.0;
    this.adsMultiplier = 0.72;
    this.invertY = false;
    this.rawInput = true;
    this._enabled = true;
    this.onLockChange = null;

    addEventListener('keydown', this._onKeyDown = (e) => {
      if (!this._enabled) return;
      if (e.code === 'Tab' || (e.code === 'Space' && this.locked)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
    });
    addEventListener('keyup', this._onKeyUp = (e) => {
      this.keys.delete(e.code);
      this.released.add(e.code);
    });
    addEventListener('blur', () => { this.keys.clear(); this.buttons.fill(false); });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.keys.clear(); this.buttons.fill(false); }
      this.onLockChange?.(this.locked);
    });

    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // movementX/Y already accounts for OS acceleration when raw input is off.
      this.mouse.dx += e.movementX ?? 0;
      this.mouse.dy += e.movementY ?? 0;
    });
    addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      e.preventDefault();
      if (e.button < 3 && !this.buttons[e.button]) this.buttonsPressed[e.button] = true;
      if (e.button < 3) this.buttons[e.button] = true;
    });
    addEventListener('mouseup', (e) => { if (e.button < 3) this.buttons[e.button] = false; });
    addEventListener('contextmenu', (e) => { if (this.locked) e.preventDefault(); });
    addEventListener('wheel', (e) => { if (this.locked) { e.preventDefault(); this.mouse.wheel += Math.sign(e.deltaY); } },
      { passive: false });
  }

  requestLock() {
    if (this.locked) return;
    const p = this.canvas.requestPointerLock?.({ unadjustedMovement: this.rawInput });
    // Chrome rejects unadjustedMovement on some platforms — fall back quietly.
    if (p?.catch) p.catch(() => this.canvas.requestPointerLock());
  }

  exitLock() { if (this.locked) document.exitPointerLock(); }
  setEnabled(v) { this._enabled = v; if (!v) this.keys.clear(); }

  down(action) {
    const b = this.binds[action];
    if (!b) return false;
    for (const k of b) if (this.keys.has(k)) return true;
    return false;
  }

  hit(action) {
    const b = this.binds[action];
    if (!b) return false;
    for (const k of b) if (this.pressed.has(k)) return true;
    return false;
  }

  /** Yaw/pitch delta in radians for this frame, after sensitivity. */
  look(adsScale = 1) {
    const base = 0.0022 * this.sensitivity * adsScale;
    const dx = this.mouse.dx * base;
    const dy = this.mouse.dy * base * (this.invertY ? -1 : 1);
    return { yaw: -dx, pitch: -dy };
  }

  /** Clears per-frame state. Call at the very end of the frame. */
  endFrame() {
    this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0;
    this.pressed.clear(); this.released.clear();
    this.buttonsPressed[0] = this.buttonsPressed[1] = this.buttonsPressed[2] = false;
  }
}
