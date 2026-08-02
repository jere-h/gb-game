// Keyboard input, polled per-frame so held keys feel smooth.
// Arrows move/aim (A/D/W/S are aliases), hold Space to charge and release to
// fire, Enter fires instantly at full charge.

const ALIAS = { KeyA: 'ArrowLeft', KeyD: 'ArrowRight', KeyW: 'ArrowUp', KeyS: 'ArrowDown' };
const HANDLED = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Enter'];

export class Input {
  constructor(game) {
    this.game = game;
    this.keys = new Set();
    window.addEventListener('keydown', (e) => {
      const code = ALIAS[e.code] || e.code;
      if (HANDLED.includes(code)) e.preventDefault();
      if (code === 'Space' && !this.keys.has('Space')) game.input('chargeStart');
      if (code === 'Enter' && !e.repeat) game.input('fireFull');
      this.keys.add(code);
    });
    window.addEventListener('keyup', (e) => {
      const code = ALIAS[e.code] || e.code;
      this.keys.delete(code);
      if (code === 'Space') game.input('chargeRelease');
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

  update(dt) {
    const g = this.game;
    if (this.keys.has('ArrowLeft')) g.input('left', dt);
    if (this.keys.has('ArrowRight')) g.input('right', dt);
    if (this.keys.has('ArrowUp')) g.input('up', dt);
    if (this.keys.has('ArrowDown')) g.input('down', dt);
  }
}
