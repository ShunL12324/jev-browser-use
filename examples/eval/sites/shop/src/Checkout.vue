<script setup>
// Two-step checkout: details, then review with the irreversible Place order.
import { ref, inject, onMounted } from 'vue'
import { api } from './api.js'
import Combobox from './Combobox.vue'
import DatePicker from './DatePicker.vue'
const labels = inject('labels'), session = inject('session'), refresh = inject('refresh')
const cart = ref(null), step = ref('details'), error = ref(''), coupon = ref(''), couponError = ref('')
const form = ref({ name: '', street: '', city: '', deliveryDate: '', shipping: 'standard' })
onMounted(async () => { cart.value = await api('/cart') })
const cities = q => api('/cities?q=' + encodeURIComponent(q))
async function apply() { couponError.value = ''; try { cart.value = await api('/coupon', { method: 'POST', body: { code: coupon.value } }) } catch (e) { couponError.value = e.message } }
async function setShipping(method) { form.value.shipping = method; cart.value = await api('/shipping', { method: 'POST', body: { method } }) }
function review() {
  error.value = ''
  if (!form.value.name || !form.value.street || !form.value.city || !form.value.deliveryDate) { error.value = 'Please complete every delivery field.'; return }
  step.value = 'review'
}
async function place() {
  error.value = ''
  try { const order = await api('/order', { method: 'POST', body: form.value }); await refresh(); location.hash = '#/order/' + order.number }
  catch (e) { error.value = e.message }
}
</script>

<template>
  <section v-if="cart">
    <h1>{{ labels.checkout }}</h1>
    <p v-if="!session.loggedIn">Please <a href="#/account">sign in</a> to check out.</p>
    <template v-else-if="step === 'details'">
      <h2>Delivery details</h2>
      <label>Full name <input v-model="form.name" name="name" autocomplete="name"></label>
      <label>Street address <input v-model="form.street" name="street"></label>
      <Combobox label="City" name="city" v-model="form.city" :fetcher="cities" />
      <DatePicker label="Delivery date" v-model="form.deliveryDate" />
      <fieldset><legend>Shipping method</legend>
        <label style="flex-direction:row;font-weight:400"><input type="radio" name="ship" value="standard" :checked="form.shipping === 'standard'" @change="setShipping('standard')"> Standard (free, 5–7 days)</label>
        <label style="flex-direction:row;font-weight:400"><input type="radio" name="ship" value="express" :checked="form.shipping === 'express'" @change="setShipping('express')"> Express ($15.00, 1–2 days)</label>
      </fieldset>
      <form class="row" @submit.prevent="apply"><label>Promo code <input v-model="coupon" name="promo"></label><button type="submit">Apply code</button></form>
      <p v-if="couponError" class="error" role="alert">{{ couponError }}</p><p v-if="cart.coupon" role="status">Code {{ cart.coupon }} applied.</p>
      <p><strong>Total {{ cart.total }}</strong></p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button class="primary" type="button" @click="review">Continue to review</button>
    </template>
    <template v-else>
      <h2>Review your order</h2>
      <ul><li v-for="l in cart.lines" :key="l.id">{{ l.qty }} × {{ l.name }} ({{ l.color }}{{ l.size ? ', ' + l.size : '' }})</li></ul>
      <p>Deliver to {{ form.name }}, {{ form.street }}, {{ form.city }} on {{ form.deliveryDate }} · {{ form.shipping }} shipping</p>
      <p v-if="cart.coupon">Promo {{ cart.coupon }}: −{{ cart.discount }}</p>
      <p><strong>Total {{ cart.total }}</strong> will be charged to the card on file.</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="row"><button type="button" @click="step = 'details'">Edit details</button><button class="primary" type="button" @click="place">Place order and pay</button></div>
    </template>
  </section>
</template>
