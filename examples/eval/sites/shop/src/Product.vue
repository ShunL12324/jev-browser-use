<script setup>
// Product page: colour swatches (radiogroup), custom size listbox, stepper.
import { ref, inject, onMounted } from 'vue'
import { api } from './api.js'
const props = defineProps({ id: Number })
const labels = inject('labels'), refresh = inject('refresh')
const p = ref(null), color = ref(''), size = ref(''), qty = ref(1), open = ref(false), message = ref(''), error = ref('')
onMounted(async () => { p.value = await api('/products/' + props.id) })
function pickSize(s) { size.value = s; open.value = false }
async function add() {
  error.value = ''; message.value = ''
  try { await api('/cart', { method: 'POST', body: { productId: p.value.id, color: color.value, size: p.value.sizes ? size.value : undefined, qty: qty.value } }); message.value = 'Added to your ' + labels.value.cart.toLowerCase() + '.'; refresh() }
  catch (e) { error.value = e.message }
}
</script>

<template>
  <article v-if="p">
    <h1>{{ p.name }}</h1>
    <p>{{ p.price }}</p>
    <div role="radiogroup" aria-labelledby="colour-label"><p id="colour-label"><strong>Colour:</strong> {{ color || 'none selected' }}</p>
      <div class="swatches"><button v-for="c in p.colors" :key="c" type="button" role="radio" :aria-checked="c === color" @click="color = c">{{ c }}</button></div>
    </div>
    <div v-if="p.sizes" class="combo" style="max-width:220px;margin-top:16px">
      <p id="size-label"><strong>Size</strong></p>
      <button type="button" aria-haspopup="listbox" :aria-expanded="open" aria-labelledby="size-label size-value" @click="open = !open"><span id="size-value">{{ size || 'Select a size' }}</span></button>
      <ul v-show="open" role="listbox" aria-labelledby="size-label">
        <li v-for="s in p.sizes" :key="s" role="option" :aria-selected="s === size" tabindex="-1" @click="pickSize(s)">{{ s }}</li>
      </ul>
    </div>
    <div class="row" style="margin-top:16px" role="group" aria-label="Quantity">
      <button type="button" aria-label="Decrease quantity" @click="qty = Math.max(1, qty - 1)">−</button>
      <output aria-live="polite" aria-label="Quantity">{{ qty }}</output>
      <button type="button" aria-label="Increase quantity" @click="qty = Math.min(9, qty + 1)">+</button>
    </div>
    <p><button class="primary" type="button" @click="add">{{ labels.add }}</button></p>
    <p v-if="message" role="status">{{ message }}</p><p v-if="error" class="error" role="alert">{{ error }}</p>
  </article>
</template>
