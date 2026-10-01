import { api, session } from './api.js';

if (session.token()) window.location.replace('/');

const $ = (id) => document.getElementById(id);
const form = $('auth-form');
const email = $('auth-email');
const password = $('auth-password');
const submit = $('auth-submit');
const error = $('auth-error');

function showError(msg) {
    error.textContent = msg;
    error.hidden = !msg;
}

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    if (!email.value.trim() || !password.value) {
        showError('请输入邮箱和密码');
        (email.value.trim() ? password : email).focus();
        return;
    }
    showError('');
    submit.disabled = true;
    submit.textContent = '登录中…';
    try {
        const res = await api('/api/auth/login', { method: 'POST', body: { email: email.value.trim(), password: password.value } });
        session.save(res.token);
        window.location.replace('/');
    } catch (err) {
        showError(err.message);
        submit.disabled = false;
        submit.textContent = '登录';
    }
});

email.focus();
