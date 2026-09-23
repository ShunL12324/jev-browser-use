<script setup>
// Catalog with autocomplete search, brand filter, sort and infinite scroll.
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { api } from './api.js'
import Combobox from './Combobox.vue'
const items = ref([]), hasMore = ref(true), loading = ref(false), brands = ref([]), brand = ref(''), sort = ref('featured'), query = ref(''), sentinel = ref(null)
let observer
async function load(reset = false) {
  if (loading.value || (!hasMore.value && !reset)) return
  loading.value = true
  if (reset) { items.value = []; hasMore.value = true }
  const params = new URLSearchParams({ q: query.value, brand: brand.value, sort: sort.value, offset: items.value.length, limit: 8 })
  const page = await api('/products?' + params)
  items.value.push(...page.items); hasMore.value = page.hasMore; loading.value = false
  // Keep filling while the sentinel is still visible after a short page.
  await nextTick()
  if (hasMore.value && sentinel.value && sentinel.value.getBoundingClientRect().top < innerHeight) load()
}
onMounted(async () => {
  brands.value = await api('/brands')
  observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) load() })
  observer.observe(sentinel.value)
  load(true)
})
onBeforeUnmount(() => observer?.disconnect())
const suggest = q => api('/suggest?q=' + encodeURIComponent(q))
function pick(option) { location.hash = '#/product/' + option.id }
function search() { load(true) }
</script>

<template>
  <div class="layout">
    <aside>
      <form role="search" @submit.prevent="search">
        <Combobox label="Search products" name="q" v-model="query" :fetcher="suggest" @pick="pick" />
        <button type="submit">Search</button>
      </form>
      <fieldset><legend>Brand</legend>
        <label v-for="b in brands" :key="b" style="flex-direction:row;font-weight:400"><input type="radio" name="brand" :value="b" v-model="brand" @change="load(true)"> {{ b }}</label>
        <label style="flex-direction:row;font-weight:400"><input type="radio" name="brand" value="" v-model="brand" @change="load(true)"> All brands</label>
      </fieldset>
      <label>Sort <select v-model="sort" @change="load(true)"><option value="featured">Featured</option><option value="price_asc">Price: low to high</option><option value="price_desc">Price: high to low</option></select></label>
    </aside>
    <section>
      <h1>All products</h1>
      <div class="grid" role="list">
        <div class="card" role="listitem" v-for="p in items" :key="p.id"><a :href="'#/product/' + p.id">{{ p.name }}</a><p>{{ p.brand }}</p><p>{{ p.price }}</p></div>
      </div>
      <div ref="sentinel" class="sentinel" aria-live="polite">{{ loading ? 'Loading more…' : hasMore ? '' : 'You have reached the end of the list.' }}</div>
    </section>
  </div>
</template>
