<script setup>
import { ref, computed, onMounted, provide } from 'vue'
import { api } from './api.js'
import Catalog from './Catalog.vue'
import Product from './Product.vue'
import Cart from './Cart.vue'
import Checkout from './Checkout.vue'
import Account from './Account.vue'

// Hash router: #/, #/product/:id, #/cart, #/checkout, #/account, #/order/:n
const route = ref(location.hash.slice(1) || '/')
window.addEventListener('hashchange', () => { route.value = location.hash.slice(1) || '/'; window.scrollTo(0, 0) })
const session = ref(null), cartCount = ref(0), showNewsletter = ref(false)
const alt = computed(() => session.value?.variant === 'alternate')
const labels = computed(() => alt.value
  ? { cart: 'Basket', add: 'Add to bag', checkout: 'Proceed to checkout', account: 'Profile', shop: 'Browse' }
  : { cart: 'Cart', add: 'Add to cart', checkout: 'Checkout', account: 'Account', shop: 'Shop' })
provide('labels', labels)
provide('session', session)
async function refresh() {
  session.value = await api('/session')
  cartCount.value = (await api('/cart')).lines.reduce((s, l) => s + l.qty, 0)
}
provide('refresh', refresh)
onMounted(async () => {
  await refresh()
  // Interstitial that blocks the page until dismissed.
  if (!session.value.newsletterSeen) setTimeout(() => { showNewsletter.value = true }, 1200)
})
async function dismiss() { showNewsletter.value = false; await api('/newsletter/dismiss', { method: 'POST' }) }
const view = computed(() => {
  const r = route.value
  if (r.startsWith('/product/')) return { c: Product, props: { id: Number(r.split('/')[2]) } }
  if (r === '/cart') return { c: Cart, props: {} }
  if (r === '/checkout') return { c: Checkout, props: {} }
  if (r === '/account') return { c: Account, props: {} }
  if (r.startsWith('/order/')) return { c: null, props: { number: r.split('/')[2] } }
  return { c: Catalog, props: {} }
})
</script>

<template>
  <div :class="{ alternate: alt }" v-if="session">
    <header>
      <a class="brand" href="#/">Lumen Outfitters</a>
      <nav aria-label="Main">
        <a href="#/">{{ labels.shop }}</a>
        <a href="#/account">{{ labels.account }}</a>
        <a href="#/cart">{{ labels.cart }} ({{ cartCount }})</a>
      </nav>
    </header>
    <main>
      <component v-if="view.c" :is="view.c" v-bind="view.props" :key="route" />
      <section v-else><h1>Order confirmed</h1><p>Your order number is <strong>{{ view.props.number }}</strong>.</p></section>
    </main>
    <div v-if="showNewsletter" class="modal" role="dialog" aria-modal="true" aria-labelledby="nl-title">
      <div><h2 id="nl-title">Get 10% off your next order</h2><p>Join our newsletter for early access to new arrivals.</p>
        <label>Email <input type="email" placeholder="you@example.com"></label>
        <div class="row"><button class="primary" type="button">Subscribe</button><button type="button" @click="dismiss">No thanks</button></div></div>
    </div>
  </div>
</template>
