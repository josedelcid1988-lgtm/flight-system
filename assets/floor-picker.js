(() => {
  const coarse = window.matchMedia('(pointer: coarse), (any-pointer: coarse)');
  if (!coarse.matches) return;

  const bounds = input => {
    const min = Number(input.min), max = Number(input.max);
    const step = input.step === '' ? 1 : Number(input.step);
    if (!Number.isInteger(min) || !Number.isInteger(max) || step !== 1 || max < min || max - min > 1000) return null;
    return { min, max };
  };

  const enhance = input => {
    if (!(input instanceof HTMLInputElement) || input.type !== 'number' || input.dataset.floorPicker) return;
    const range = bounds(input);
    if (!range || input.disabled || input.readOnly) return;
    input.dataset.floorPicker = 'true';
    input.inputMode = 'numeric';
    const name = (input.labels?.[0]?.textContent || input.name || 'value').trim().replace(/\s+/g, ' ');
    const frame = document.createElement('span');
    frame.className = 'fs-floor-picker';
    frame.setAttribute('role', 'group');
    frame.setAttribute('aria-label', `${name}, bounded whole-number picker`);
    input.parentNode.insertBefore(frame, input);
    frame.append(input);

    const makeButton = (direction, glyph, label) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fs-floor-picker-step';
      button.dataset.floorPickerStep = String(direction);
      button.setAttribute('aria-label', `${label} ${name}`);
      button.textContent = glyph;
      button.addEventListener('pointerdown', event => event.preventDefault());
      return button;
    };
    frame.prepend(makeButton(-1, '⌃', 'Decrease'));
    frame.append(makeButton(1, '⌄', 'Increase'));
    frame._floorPickerBounds = range;

    let startY = null;
    input.addEventListener('pointerdown', event => { if (event.pointerType === 'touch') startY = event.clientY; });
    input.addEventListener('pointerup', event => {
      if (startY === null || event.pointerType !== 'touch') return;
      const delta = startY - event.clientY;
      startY = null;
      if (Math.abs(delta) < 18) return;
      event.preventDefault();
      step(input, Math.sign(delta) * Math.max(1, Math.min(5, Math.floor(Math.abs(delta) / 36))));
    });
    input.addEventListener('pointercancel', () => { startY = null; });
  };

  function step(input, amount) {
    const range = bounds(input);
    if (!range) return;
    const current = Number(input.value);
    const value = Math.min(range.max, Math.max(range.min, (Number.isInteger(current) ? current : range.min) + amount));
    if (value === current) return;
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-floor-picker-step]');
    if (!button) return;
    const input = button.parentElement.querySelector('input[type="number"]');
    if (input) step(input, Number(button.dataset.floorPickerStep));
  });

  const scan = root => {
    if (root instanceof HTMLInputElement) enhance(root);
    root.querySelectorAll?.('input[type="number"][min][max]').forEach(enhance);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scan(document));
  else scan(document);
  new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
    if (node.nodeType === Node.ELEMENT_NODE) scan(node);
  }))).observe(document.documentElement, { childList: true, subtree: true });
})();
