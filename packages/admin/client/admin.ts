/**
 * Progressive enhancement for the Origin admin UI. Every page works without this script. It only
 * writes text (textContent), never markup: the pages enforce Trusted Types with no policy, so any
 * HTML sink would throw.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Show times in the browser's time zone. Times of day under a day's heading (data-format) stay in
 * the server's time zone, which their headings are in.
 */
function localTimes(): void {
  for (const el of document.querySelectorAll<HTMLTimeElement>(
    'time[datetime]:not([data-format])',
  )) {
    const d = new Date(el.dateTime);
    if (Number.isNaN(d.getTime())) continue;
    el.textContent = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    el.title = d.toString();
  }
}

/**
 * Copy buttons for command snippets and new tokens. After copying, a button shows its check mark
 * and its "copied" label for a moment.
 */
function copyButtons(): void {
  if (!navigator.clipboard) return;
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
    const target = document.getElementById(button.dataset.copy ?? '');
    if (!target) continue;
    const copyIcon = button.querySelector<HTMLElement>('[data-copy-icon]');
    const copiedIcon = button.querySelector<HTMLElement>('[data-copied-icon]');
    const label = button.querySelector<HTMLElement>('[data-copy-label]');
    const copied = button.dataset.copied ?? '';
    const before = { label: label?.textContent ?? '', aria: button.getAttribute('aria-label') };
    const show = (done: boolean) => {
      if (copyIcon) copyIcon.hidden = done;
      if (copiedIcon) copiedIcon.hidden = !done;
      if (label) label.textContent = done ? copied : before.label;
      if (before.aria !== null) {
        button.setAttribute('aria-label', done ? copied : before.aria);
        button.title = done ? copied : before.aria;
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    button.hidden = false;
    button.addEventListener('click', () => {
      navigator.clipboard.writeText(target.textContent ?? '').then(
        () => {
          show(true);
          clearTimeout(timer);
          timer = setTimeout(() => show(false), 1500);
        },
        () => {},
      );
    });
  }
}

/** Load an event's original line in place, instead of opening its page. */
function rawLines(): void {
  const out = document.getElementById('raw-line');
  for (const form of document.querySelectorAll<HTMLFormElement>('form[data-raw]')) {
    if (!out) continue;
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const id = form.dataset.raw ?? '';
      fetch(`/admin/api/event-raw?id=${encodeURIComponent(id)}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then((data: { line: string | null; truncated: boolean }) => {
          out.textContent =
            data.line === null ? '—' : data.truncated ? `${data.line} …` : data.line;
          // The line sits in a hidden code frame; show the frame.
          (out.closest<HTMLElement>('[hidden]') ?? out).hidden = false;
          form.hidden = true;
        })
        .catch(() => form.submit());
    });
  }
}

localTimes();
copyButtons();
rawLines();

export {};
