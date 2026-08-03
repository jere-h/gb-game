// Keyboard input, polled per-frame so held keys feel smooth.
// Arrows move/aim (A/D/W/S are aliases), hold Space to charge and release to
// fire, Enter fires instantly at full charge.
// Touch controls call press()/release() with the same key codes, so virtual
// buttons behave exactly like held keys.

const ALIAS = { KeyA: 'ArrowLeft', KeyD: 'ArrowRight', KeyW: 'ArrowUp', KeyS: 'ArrowDown' };
const HANDLED = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Enter'];

export class Input {
  constructor(game) {
    this.game = game;
    this.keys = new Set();
    window.addEventListener('keydown', (e) => {
      const code = ALIAS[e.code] || e.code;
      if (HANDLED.includes(code)) e.preventDefault();
      if (code === 'Enter' && !e.repeat) game.input('fireFull');
      this.press(code);
    });
    window.addEventListener('keyup', (e) => {
      this.release(ALIAS[e.code] || e.code);
    });
    window.addEventListener('blur', () => {
      if (this.keys.has('Space')) this.game.input('chargeRelease');
      this.keys.clear();
    });
  }

  press(code) {
    if (code === 'Space' && !this.keys.has('Space')) this.game.input('chargeStart');
    this.keys.add(code);
  }

  release(code) {
    this.keys.delete(code);
    if (code === 'Space') this.game.input('chargeRelease');
  }

  update(dt) {
    const g = this.game;
    if (this.keys.has('ArrowLeft')) g.input('left', dt);
    if (this.keys.has('ArrowRight')) g.input('right', dt);
    if (this.keys.has('ArrowUp')) g.input('up', dt);
    if (this.keys.has('ArrowDown')) g.input('down', dt);
  }
}
