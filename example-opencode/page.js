export const PAGE = String.raw`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCode · celld</title>
<style>
  :root { color-scheme: light; font: 16px/1.6 system-ui, sans-serif; color: #23332f; background: #f6f7f4; }
  * { box-sizing: border-box; }
  body { margin: 0; }
  main { max-width: 800px; margin: 64px auto; padding: 0 24px; }
  .eyebrow { color: #4b665e; font-size: 12px; letter-spacing: .12em; text-transform: uppercase; font-weight: 650; }
  h1 { font-size: clamp(28px, 5vw, 40px); letter-spacing: -.04em; line-height: 1.2; margin: 12px 0; }
  p { margin: 0 0 20px; }
  .muted, small { color: #5f6c67; }
  .panel { background: #fff; border: 1px solid #d7dfd8; border-radius: 12px; padding: 24px; margin: 24px 0; }
  label { display: block; font-size: 13px; font-weight: 650; margin-bottom: 7px; }
  .row { display: flex; gap: 8px; align-items: center; }
  input, textarea, button { font: inherit; border: 1px solid #b8c5bc; border-radius: 6px; }
  input, textarea { width: 100%; min-width: 0; padding: 10px 12px; background: #fff; color: inherit; }
  #session { font: 13px/1.8 ui-monospace, monospace; }
  textarea { resize: vertical; min-height: 112px; }
  button { padding: 10px 16px; white-space: nowrap; cursor: pointer; background: #fff; color: #23332f; }
  button:hover:not(:disabled) { background: #edf2ed; }
  button.primary { background: #245c49; border-color: #245c49; color: #fff; }
  button.primary:hover:not(:disabled) { background: #194936; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  :focus-visible { outline: 3px solid #81ad98; outline-offset: 3px; }
  .actions { justify-content: space-between; flex-wrap: wrap; margin-top: 14px; }
  #status { min-height: 1.6em; font-size: 14px; margin: 16px 0 0; }
  #status.error { color: #a03225; }
  #messages { margin-bottom: 24px; }
  article { border-bottom: 1px solid #e2e7e0; padding: 18px 0; }
  article:first-child { padding-top: 0; }
  article h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #5f6c67; margin: 0 0 8px; }
  article p { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
  code { overflow-wrap: anywhere; font-size: 12px; }
  footer { font-size: 13px; color: #5f6c67; }
  @media (max-width: 540px) { main { margin: 32px auto; padding: 0 16px; } .panel { padding: 18px; } .session-row { flex-wrap: wrap; } .session-row input { flex-basis: 100%; } }
</style>
<main>
  <header>
    <div class="eyebrow">celld / OpenCode sample</div>
    <h1>A conversation you can return to.</h1>
    <p class="muted">Create a session, send a prompt, then resume it by ID. OpenCode runs inside a SQLite Durable Object—not a separate agent server.</p>
    <small>Model · <code>opencode/nemotron-3.5-lightning-free</code></small>
  </header>
  <section class="panel" aria-label="Session">
    <label for="session">Session ID</label>
    <div class="row session-row">
      <input id="session" placeholder="Create a session or paste its ID" autocomplete="off" spellcheck="false">
      <button id="resume" type="button">Resume</button>
      <button id="create" type="button">New session</button>
    </div>
    <small>Keep this ID to return. It grants access to this demo conversation.</small>
    <p id="status" role="status" aria-live="polite">Start a new session to try it.</p>
  </section>
  <section class="panel" aria-label="Conversation">
    <div id="messages"><p class="muted">Your conversation will appear here.</p></div>
    <form id="form">
      <label for="prompt">Your prompt</label>
      <textarea id="prompt" maxlength="8000" required placeholder="Try: Remember the word cedar. I’ll ask you about it next." disabled></textarea>
      <div class="row actions"><small>Replies appear when the turn finishes.</small><button class="primary" id="send" disabled>Send prompt</button></div>
    </form>
  </section>
  <footer>Session history lives in Durable Object storage: local disk in development, Cloud Storage when deployed with celld. This demo has no user accounts. Don’t enter secrets; prompts are sent to the model provider. No shell or persistent project filesystem is provided.</footer>
</main>
<script>
  const $ = id => document.getElementById(id);
  let activeID = null;
  let busy = false;
  function controls() {
    for (const id of ['create', 'resume', 'session']) $(id).disabled = busy;
    $('prompt').disabled = busy || !activeID;
    $('send').disabled = busy || !activeID;
    $('send').textContent = busy ? 'Please wait…' : 'Send prompt';
  }
  function status(text, error = false) { $('status').textContent = text; $('status').className = error ? 'error' : ''; }
  async function api(path, body) {
    const response = await fetch('/api/sessions' + path, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }
  function render(data) {
    $('messages').replaceChildren();
    for (const message of data.messages) {
      if (!['user', 'assistant'].includes(message.type)) continue;
      const text = message.type === 'user' ? message.text :
        (message.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n') ||
        (message.error ? 'Model error: ' + JSON.stringify(message.error) : 'No text reply.');
      if (!text) continue;
      const article = document.createElement('article');
      const heading = document.createElement('h2'); heading.textContent = message.type === 'user' ? 'You' : 'OpenCode';
      const paragraph = document.createElement('p'); paragraph.textContent = text;
      article.append(heading, paragraph); $('messages').append(article);
    }
    if (!$('messages').children.length) $('messages').textContent = 'Session ready. Send your first prompt.';
  }
  async function run(task) {
    busy = true; controls();
    try { await task(); } catch (error) { status(error.message, true); }
    finally { busy = false; controls(); }
  }
  async function resume(id) {
    activeID = null;
    status('Loading session…');
    const data = await api('/' + encodeURIComponent(id));
    activeID = id; $('session').value = id;
    history.replaceState(null, '', '#' + id);
    render(data); status(data.busy ? 'A turn is running. Resume again in a moment to load its reply.' : 'Session loaded. Ready for your next prompt.');
  }
  $('create').onclick = () => run(async () => {
    status('Creating session…');
    const { id } = await api('', {}); await resume(id); $('prompt').value = '';
  });
  $('session').oninput = () => { activeID = null; controls(); };
  $('resume').onclick = () => run(() => resume($('session').value.trim()));
  $('form').onsubmit = event => {
    event.preventDefault();
    if (busy || !activeID || !$('prompt').value.trim()) return;
    run(async () => {
      status('Waiting for OpenCode… Keep this session ID if you leave.');
      const data = await api('/' + activeID + '/prompt', { text: $('prompt').value });
      render(data); $('prompt').value = ''; status('Turn finished. Send a follow-up or resume this ID later.');
    });
  };
  if (location.hash.slice(1)) run(() => resume(location.hash.slice(1)));
</script>
</html>`;
