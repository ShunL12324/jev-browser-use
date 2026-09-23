<script setup>
// Sign-in with a second one-time-code step, loyalty points and address book.
import { ref, inject, onMounted } from 'vue'
import { api } from './api.js'
import Combobox from './Combobox.vue'
const session = inject('session'), refresh = inject('refresh')
const step = ref('password'), email = ref(''), password = ref(''), code = ref(''), error = ref(''), account = ref(null)
const addr = ref({ name: '', street: '', city: '', postal: '', phone: '' }), errors = ref({}), saved = ref('')
async function load() { if (session.value.loggedIn) account.value = await api('/account') }
onMounted(load)
async function signIn() { error.value = ''; try { await api('/login', { method: 'POST', body: { email: email.value, password: password.value } }); step.value = 'code' } catch (e) { error.value = e.message } }
async function verify() { error.value = ''; try { await api('/login/code', { method: 'POST', body: { code: code.value } }); await refresh(); await load() } catch (e) { error.value = e.message } }
const cities = q => api('/cities?q=' + encodeURIComponent(q))
async function save() {
  errors.value = {}; saved.value = ''
  try { await api('/addresses', { method: 'POST', body: addr.value }); saved.value = 'Address saved.'; await load() } catch (e) { errors.value = e.data?.errors ?? { form: e.message } }
}
</script>

<template>
  <section v-if="!session.loggedIn">
    <h1>Sign in</h1>
    <form v-if="step === 'password'" @submit.prevent="signIn">
      <label>Email address <input v-model="email" type="email" name="email" autocomplete="username"></label>
      <label>Password <input v-model="password" type="password" name="password" autocomplete="current-password"></label>
      <button class="primary" type="submit">Sign in</button>
    </form>
    <form v-else @submit.prevent="verify">
      <p>We sent a 6-digit code to your phone.</p>
      <label>Verification code <input v-model="code" inputmode="numeric" name="code" autocomplete="one-time-code"></label>
      <button class="primary" type="submit">Verify</button>
    </form>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
  <section v-else-if="account">
    <h1>Your account</h1>
    <p>Signed in as {{ account.email }}</p>
    <p>Loyalty points balance: <strong>{{ account.points.toLocaleString('en-US') }}</strong></p>
    <h2>Address book</h2>
    <ul><li v-for="(a, i) in account.addresses" :key="i">{{ a.name }}, {{ a.street }}, {{ a.city }} {{ a.postal }} · {{ a.phone }}</li></ul>
    <form @submit.prevent="save">
      <h3>Add an address</h3>
      <label>Name <input v-model="addr.name" name="addr-name"></label><p v-if="errors.name" class="error">{{ errors.name }}</p>
      <label>Street <input v-model="addr.street" name="addr-street"></label><p v-if="errors.street" class="error">{{ errors.street }}</p>
      <Combobox label="Town or city" name="addr-city" v-model="addr.city" :fetcher="cities" /><p v-if="errors.city" class="error">{{ errors.city }}</p>
      <label>Postal code <input v-model="addr.postal" name="addr-postal"></label><p v-if="errors.postal" class="error">{{ errors.postal }}</p>
      <label>Phone <input v-model="addr.phone" name="addr-phone" type="tel"></label><p v-if="errors.phone" class="error" role="alert">{{ errors.phone }}</p>
      <button type="submit">Save address</button><p v-if="saved" role="status">{{ saved }}</p>
    </form>
  </section>
</template>
