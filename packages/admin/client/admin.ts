/**
 * Progressive enhancement for the Origin admin UI. Every page works without this script. It only
 * writes text (textContent), never markup: the pages enforce Trusted Types with no policy, so any
 * HTML sink would throw.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** Show times in the browser's time zone. */
function localTimes(): void {
  for (const el of document.querySelectorAll<HTMLTimeElement>('time[datetime]')) {
    const d = new Date(el.dateTime);
    if (Number.isNaN(d.getTime())) continue;
    el.textContent = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    el.title = d.toString();
  }
}

/** Copy buttons for command snippets and new tokens. */
function copyButtons(): void {
  if (!navigator.clipboard) return;
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
    const target = document.getElementById(button.dataset.copy ?? '');
    if (!target) continue;
    const label = button.textContent ?? '';
    button.hidden = false;
    button.addEventListener('click', () => {
      navigator.clipboard.writeText(target.textContent ?? '').then(
        () => {
          button.textContent = '✓';
          setTimeout(() => {
            button.textContent = label;
          }, 1500);
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
          out.hidden = false;
          form.hidden = true;
        })
        .catch(() => form.submit());
    });
  }
}

/** Keep "forget" disabled until the id has been typed. The server checks it again. */
function confirmForms(): void {
  for (const form of document.querySelectorAll<HTMLFormElement>('form[data-confirm]')) {
    const expected = form.dataset.confirm ?? '';
    const input = form.querySelector<HTMLInputElement>('input[name="confirm"]');
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!input || !submit) continue;
    const update = () => {
      submit.disabled = input.value.trim() !== expected;
    };
    input.addEventListener('input', update);
    update();
  }
}

localTimes();
copyButtons();
rawLines();
confirmForms();

export {};
