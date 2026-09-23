<script setup>
import { ref, inject, onMounted } from 'vue'
import { api } from './api.js'
const labels = inject('labels'), refresh = inject('refresh')
const cart = ref(null), coupon = ref(''), error = ref('')
onMounted(async () => { cart.value = await api('/cart') })
async function setQty(line, qty) { cart.value = await api('/cart/' + line.id, { method: 'PATCH', body: { qty: Number(qty) } }); refresh() }
async function remove(line) { cart.value = await api('/cart/' + line.id, { method: 'DELETE' }); refresh() }
async function apply() { error.value = ''; try { cart.value = await api('/coupon', { method: 'POST', body: { code: coupon.value } }) } catch (e) { error.value = e.message } }
</script>

<template>
  <section v-if="cart">
    <h1>Your {{ labels.cart.toLowerCase() }}</h1>
    <p v-if="!cart.lines.length">Your {{ labels.cart.toLowerCase() }} is empty.</p>
    <table v-else class="cart"><tbody>
      <tr v-for="l in cart.lines" :key="l.id">
        <td>{{ l.name }}<br><small>{{ l.color }}{{ l.size ? ' · ' + l.size : '' }}</small></td>
        <td><label>Quantity for {{ l.name }} <select :value="l.qty" @change="setQty(l, $event.target.value)"><option v-for="n in 9" :key="n" :value="n">{{ n }}</option></select></label></td>
        <td>{{ l.lineTotal }}</td>
        <td><button type="button" :aria-label="'Remove ' + l.name" @click="remove(l)">Remove</button></td>
      </tr></tbody></table>
    <form class="row" @submit.prevent="apply"><label>Promo code <input v-model="coupon" name="coupon"></label><button type="submit">Apply</button></form>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="cart.coupon" role="status">Code {{ cart.coupon }} applied: −{{ cart.discount }}</p>
    <p>Subtotal {{ cart.subtotal }} · <strong>Total {{ cart.total }}</strong></p>
    <a v-if="cart.lines.length" href="#/checkout"><button class="primary" type="button">{{ labels.checkout }}</button></a>
  </section>
</template>
