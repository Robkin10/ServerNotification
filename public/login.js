const form = document.querySelector('#login-form');
const username = document.querySelector('#username');
const password = document.querySelector('#password');
const submit = document.querySelector('#login-submit');
const message = document.querySelector('#login-message');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  submit.disabled = true;
  submit.textContent = 'Signing in…';
  message.textContent = '';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value, password: password.value })
    });
    const payload = await response.json();
    if (!response.ok || payload.success !== true) throw new Error(payload.message || 'Sign in failed.');
    window.location.replace('/');
  } catch (error) {
    message.textContent = error.message || 'Sign in failed. Please try again.';
    password.focus();
  } finally {
    submit.disabled = false;
    submit.textContent = 'Sign in';
  }
});
