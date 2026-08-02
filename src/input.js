// Keyboard input, polled per-frame so held keys feel smooth.

export class Input {
  constructor(game) {
    this.game = game;
    this.keys = new Set();
    window.addEventListener('keydown', (e) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault();
      if (e.code === 'Space' && !this.keys.has('Space')) game.input('chargeStart');
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Space') game.input('chargeRelease');
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
