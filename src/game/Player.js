/* ══════════════════════════════════════════════════════════════════════════
   LocalPlayer — input, camera and the feel of being the one holding the gun.
   ══════════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { BTN, MOVE } from './Combatant.js';
import { WEAPONS, THROWABLES } from './Weapons.js';
import { clamp, clamp01, damp, lerp, rand, smoothstep, TAU } from '../core/MathUtils.js';

const _v = new THREE.Vector3();

export class LocalPlayer {
  constructor(combatant, input, renderer, viewModel, settings) {
    this.c = combatant;
    this.input = input;
    this.renderer = renderer;
    this.vm = viewModel;
    this.settings = settings;

    this.yaw = 0;
    this.pitch = 0;
    this.cmd = { seq: 0, dt: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 };

    this.shake = 0;
    this.shakeSeed = rand(0, 100);
    this.camOffset = new THREE.Vector3();
    this.bobPhase = 0;
    this.landDip = 0;
    this.landDipVel = 0;
    this.slideLean = 0;
    this.lastSlot = 1;

    this.cookingKind = null;
    this.cookStart = 0;
    this.throwRequest = null;
    this.holdBreath = 0;
    this.breathT = rand(0, 10);
    this.scopeBlend = 0;
    this.lowered = 0;
    this.inspectCd = 0;
    this.hudFov = settings.fov ?? 85;
  }

  reset(yaw) {
    this.yaw = yaw ?? 0;
    this.pitch = 0;
    this.shake = 0;
    this.cookingKind = null;
    this.landDip = this.landDipVel = 0;
    this.scopeBlend = 0;
    this.vm.setWeapon(this.c.weapon);
    this.vm.playDraw(0.5);
  }

  addShake(amount) { this.shake = Math.min(1.4, this.shake + amount); }

  /* ── input → command ───────────────────────────────────────────────────── */
  buildCommand(dt, allowLook = true) {
    const inp = this.input;
    const c = this.c;
    const w = c.weapon;

    if (allowLook && inp.locked) {
      const adsScale = lerp(1, this.settings.adsSensitivity ?? 0.72, c.adsAmount);
      // Scoped optics scale sensitivity by magnification so tracking stays sane.
      const zoomScale = w.scope ? lerp(1, 1 / Math.sqrt(w.scope.zoom), this.scopeBlend) : 1;
      const look = inp.look(adsScale * zoomScale);
      this.yaw += look.yaw;
      this.pitch = clamp(this.pitch + look.pitch, -1.52, 1.52);
      if (this.yaw > Math.PI) this.yaw -= TAU;
      if (this.yaw < -Math.PI) this.yaw += TAU;
    }

    let buttons = 0;
    const alive = c.alive;
    if (alive && inp.locked) {
      if (inp.down('forward')) buttons |= 0;
      if (inp.down('jump')) buttons |= BTN.jump;
      if (inp.down('crouch')) buttons |= BTN.crouch;
      if (inp.down('sprint')) buttons |= BTN.sprint;
      if (inp.buttons[2]) buttons |= BTN.ads;    // some mice map ADS to MMB
      if (inp.buttons[1]) buttons |= BTN.ads;

      const fireHeld = inp.buttons[0];
      const firePressed = inp.buttonsPressed[0];
      if (w.melee) { if (firePressed) buttons |= BTN.fire; }
      else if (w.fireMode === 'auto') { if (fireHeld) buttons |= BTN.fire; }
      else if (firePressed) buttons |= BTN.fire;

      if (inp.hit('reload')) buttons |= BTN.reload;
      if (inp.hit('melee')) buttons |= BTN.melee;
      if (inp.hit('slot1')) buttons |= BTN.slot0;
      if (inp.hit('slot2')) buttons |= BTN.slot1;
      if (inp.hit('slot3')) buttons |= BTN.slot2;
      if (inp.hit('swap')) buttons |= (c.slot === 0 ? BTN.slot1 : BTN.slot0);
    }

    let mx = 0, mz = 0;
    if (alive && inp.locked) {
      if (inp.down('forward')) mz += 1;
      if (inp.down('back')) mz -= 1;
      if (inp.down('right')) mx += 1;
      if (inp.down('left')) mx -= 1;
      const l = Math.hypot(mx, mz);
      if (l > 1) { mx /= l; mz /= l; }
    }

    const cmd = this.cmd;
    cmd.seq++;
    cmd.dt = dt;
    cmd.moveX = mx;
    cmd.moveZ = mz;
    cmd.yaw = this.yaw;
    cmd.pitch = this.pitch;
    cmd.buttons = buttons;
    return cmd;
  }

  /** Grenade cook/throw, handled outside the movement command. */
  updateThrowables(now) {
    const inp = this.input;
    const c = this.c;
    if (!c.alive || !inp.locked) { this.cookingKind = null; return; }

    const start = (kind) => {
      if (this.cookingKind || c.busy) return;
      const count = kind === 'lethal' ? c.lethalCount : c.tacticalCount;
      if (count <= 0) return;
      this.cookingKind = kind;
      this.cookStart = now;
      this.vm.hidden = false;
    };
    if (inp.hit('frag')) start('lethal');
    if (inp.hit('tactical')) start('tactical');

    if (this.cookingKind) {
      const kind = this.cookingKind;
      const id = kind === 'lethal' ? c.lethal : c.tactical;
      const def = THROWABLES[id];
      const held = now - this.cookStart;
      const keyDown = kind === 'lethal' ? inp.down('frag') : inp.down('tactical');
      // Cookable grenades detonate in your hand if you hold too long.
      const cooked = def.cook ? Math.min(held, def.fuse) : Math.min(held, 0.35);
      if (!keyDown || (def.cook && held > def.fuse)) {
        this.throwRequest = { kind, id, cook: cooked, overcooked: def.cook && held >= def.fuse };
        this.cookingKind = null;
      }
    }
  }

  takeThrowRequest() {
    const r = this.throwRequest;
    this.throwRequest = null;
    return r;
  }

  /* ── camera + view model ───────────────────────────────────────────────── */
  update(dt, now, ctx) {
    const c = this.c;
    const r = this.renderer;
    const cam = r.camera;
    const w = c.weapon;

    /* ── FOV ─────────────────────────────────────────────────────── */
    const baseFov = this.settings.fov ?? 85;
    const sprintBoost = c.sprinting ? 5.5 : 0;
    const slideBoost = c.sliding ? 8 : 0;
    const adsFov = baseFov * (w.adsFov ?? 0.7);
    const targetFov = lerp(baseFov + sprintBoost + slideBoost, adsFov, smoothstep(c.adsAmount));
    this.hudFov = damp(this.hudFov, targetFov, 14, dt);
    r.setFov(this.hudFov);
    r.setVmFov(lerp(62, 50, c.adsAmount));

    /* ── scope ───────────────────────────────────────────────────── */
    const scoped = !!w.scope && c.adsAmount > 0.5;
    const scopeTarget = w.scope ? clamp01((c.adsAmount - 0.55) / 0.35) : 0;
    this.scopeBlend = damp(this.scopeBlend, scopeTarget, 22, dt);
    if (this.scopeBlend > 0.002 && w.scope) {
      // Magnification is defined against the *base* FOV, not the current one.
      const scopeFov = (2 * Math.atan(Math.tan((baseFov * Math.PI) / 360) / w.scope.zoom) * 180) / Math.PI;
      r.setScopeFov(scopeFov);
    }
    // Holding breath steadies a scoped shot for a few seconds.
    if (scoped && this.input.down('sprint') && this.holdBreath < 1) this.holdBreath = Math.min(1, this.holdBreath + dt / 0.25);
    else this.holdBreath = Math.max(0, this.holdBreath - dt / 1.6);
    this.breathT += dt * (1 + this.holdBreath * 0.4);

    /* ── camera transform ────────────────────────────────────────── */
    c.eyePos(_v);

    // Landing dip.
    if (ctx.landImpulse) this.landDipVel -= ctx.landImpulse * 0.55;
    this.landDipVel += (-this.landDip * 190 - this.landDipVel * 19) * dt;
    this.landDip += this.landDipVel * dt;

    // Walk bob — subtle, and mostly gone while aiming.
    const speed01 = clamp01(Math.hypot(c.vel.x, c.vel.z) / MOVE.walk);
    this.bobPhase += dt * (7.4 + 5 * speed01) * (c.grounded ? speed01 : 0);
    const bobAmt = speed01 * lerp(0.026, 0.005, c.adsAmount) * (c.grounded ? 1 : 0.15);
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * bobAmt;
    const bobX = Math.sin(this.bobPhase) * bobAmt * 0.8;

    this.slideLean = damp(this.slideLean, c.sliding ? 1 : 0, 11, dt);

    cam.position.set(
      _v.x + bobX * 0.5,
      _v.y + bobY + this.landDip - this.slideLean * 0.18,
      _v.z);

    // Screen shake decays fast and never fights the player's aim.
    this.shake = Math.max(0, this.shake - dt * 1.9);
    const sh = this.shake * this.shake;
    const st = now * 34 + this.shakeSeed;
    const shakeYaw = Math.sin(st * 1.7) * 0.02 * sh + Math.sin(st * 3.1) * 0.008 * sh;
    const shakePitch = Math.cos(st * 2.3) * 0.018 * sh + Math.sin(st * 4.7) * 0.006 * sh;
    const shakeRoll = Math.sin(st * 1.3) * 0.05 * sh;

    // Scope sway: breathing wander, steadied by holding breath.
    const swayAmp = (1 - this.holdBreath * 0.86) * lerp(1, 2.6, speed01);
    const swayX = Math.sin(this.breathT * 0.83) * 0.0042 * swayAmp + Math.sin(this.breathT * 1.9) * 0.0016 * swayAmp;
    const swayY = Math.cos(this.breathT * 0.61) * 0.0048 * swayAmp + Math.cos(this.breathT * 2.3) * 0.0014 * swayAmp;

    const viewYaw = c.yaw + c.aimPunch.x + shakeYaw + (w.scope ? swayX * 0.55 : 0);
    const viewPitch = clamp(c.pitch + c.aimPunch.y + shakePitch + (w.scope ? swayY * 0.55 : 0), -1.54, 1.54);
    const roll = shakeRoll + this.slideLean * 0.1 + (c.vel.x * Math.cos(c.yaw) - c.vel.z * Math.sin(c.yaw)) * -0.004;

    cam.rotation.set(0, 0, 0);
    cam.rotateY(viewYaw);
    cam.rotateX(viewPitch);
    cam.rotateZ(roll);
    cam.updateMatrixWorld();

    // The scope camera shares the eye but zooms; its own sway is applied in
    // screen space by the composite shader so the reticle floats correctly.
    r.scopeCamera.position.copy(cam.position);
    r.scopeCamera.quaternion.copy(cam.quaternion);
    r.scopeCamera.updateMatrixWorld();
    this.scopeSway = { x: swayX * 0.9, y: swayY * 0.9 };

    /* ── view model ──────────────────────────────────────────────── */
    // Lower the weapon when the muzzle would be inside a wall.
    const dir = _v.set(-Math.sin(c.yaw), 0, -Math.cos(c.yaw));
    const wallHit = ctx.world.raycast(cam.position, dir, 0.85);
    const wantLower = wallHit && c.adsAmount < 0.3 && !w.melee ? clamp01(1 - wallHit.t / 0.85) : 0;
    this.lowered = damp(this.lowered, wantLower, 12, dt);

    // Derived from state rather than events, so a missed respawn callback
    // can never leave the player holding an invisible weapon.
    this.vm.hidden = this.scopeBlend > 0.92 || !c.alive;
    this.vm.update({
      dt,
      lookDx: this.input.mouse.dx * 0.02,
      lookDy: this.input.mouse.dy * 0.02,
      speed01,
      grounded: c.grounded,
      ads: smoothstep(c.adsAmount),
      sprint: c.sprinting ? 1 : 0,
      crouch: c.crouch,
      landImpulse: ctx.landImpulse ?? 0,
      worldPos: cam.position,
      lowered: this.lowered,
    });
  }
}
