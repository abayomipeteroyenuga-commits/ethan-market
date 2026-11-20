'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const ownerEmail = 'abayomipeteroyenuga@gmail.com';

  function setMode(mode, updateUrl = true) {
    const registering = mode === 'register';
    $('login-panel').hidden = registering;
    $('register-panel').hidden = !registering;
    $('login-tab').setAttribute('aria-selected', String(!registering));
    $('register-tab').setAttribute('aria-selected', String(registering));
    if (updateUrl) {
      const url = registering ? '/register' : '/login';
      history.replaceState(null, '', url);
    }
    (registering ? $('register-email') : $('login-email')).focus({preventScroll:true});
  }

  async function api(action, payload) {
    let response;
    try {
      response = await fetch('/api/market', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {'Content-Type':'application/json','Accept':'application/json'},
        body: JSON.stringify({action, ...payload})
      });
    } catch {
      throw new Error('Could not connect to ETHAN MARKET. Check your internet connection and try again.');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'We could not complete your request. Please try again.');
    return body.data || {};
  }

  function showMessage(id, message) {
    const el = $(id);
    el.textContent = message;
    el.hidden = !message;
  }

  function updateOwnerField() {
    const owner = $('register-email').value.trim().toLowerCase() === ownerEmail;
    $('owner-token-wrap').hidden = !owner;
    $('owner-token').required = owner;
  }

  document.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  });

  $('register-email').addEventListener('input', updateOwnerField);

  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    showMessage('login-error', '');
    showMessage('login-success', '');
    const button = $('login-submit');
    button.disabled = true;
    button.textContent = 'Signing in…';
    try {
      await api('auth.login', {
        email: $('login-email').value.trim(),
        password: $('login-password').value
      });
      showMessage('login-success', 'Sign-in successful. Opening your marketplace account…');
      window.location.assign('/');
    } catch (error) {
      showMessage('login-error', error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Sign in securely';
    }
  });

  $('register-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    showMessage('register-error', '');
    showMessage('register-success', '');
    const password = $('register-password').value;
    if (password !== $('register-confirm').value) {
      showMessage('register-error', 'Your passwords do not match. Please check and try again.');
      $('register-confirm').focus();
      return;
    }
    if (password.length < 10) {
      showMessage('register-error', 'Use a password of at least 10 characters.');
      $('register-password').focus();
      return;
    }
    const button = $('register-submit');
    button.disabled = true;
    button.textContent = 'Creating your account…';
    const payload = {
      full_name: $('register-name').value.trim(),
      phone: $('register-phone').value.trim(),
      email: $('register-email').value.trim(),
      password
    };
    if (!$('owner-token-wrap').hidden) payload.owner_token = $('owner-token').value.trim();
    try {
      await api('auth.register', payload);
      showMessage('register-success', 'Your account has been created. Opening ETHAN MARKET…');
      window.location.assign('/');
    } catch (error) {
      showMessage('register-error', error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Create my account';
    }
  });

  $('year').textContent = new Date().getFullYear();
  const mode = new URLSearchParams(location.search).get('mode') ||
    (location.pathname === '/register' || location.pathname === '/register/' ? 'register' : 'login');
  setMode(mode === 'register' ? 'register' : 'login', false);
})();
