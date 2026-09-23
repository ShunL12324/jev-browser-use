<script setup>
// Calendar dialog; the text field is read-only, so a date can only be chosen
// by navigating months and clicking a day. Store date is fixed to 2026-10-01.
import { ref, computed } from 'vue'
const props = defineProps({ modelValue: String, label: String })
const emit = defineEmits(['update:modelValue'])
const open = ref(false), month = ref(new Date(Date.UTC(2026, 9, 1)))
const first = new Date(Date.UTC(2026, 9, 3)), last = new Date(Date.UTC(2026, 11, 20))
const title = computed(() => month.value.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }))
const weeks = computed(() => {
  const y = month.value.getUTCFullYear(), m = month.value.getUTCMonth(), start = new Date(Date.UTC(y, m, 1)), days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  const cells = Array((start.getUTCDay() + 6) % 7).fill(null)
  for (let d = 1; d <= days; d++) cells.push(new Date(Date.UTC(y, m, d)))
  const rows = []; for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7))
  return rows
})
const iso = d => d.toISOString().slice(0, 10)
const usable = d => d >= first && d <= last && d.getUTCDay() !== 0
const display = computed(() => props.modelValue ? new Date(props.modelValue + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '')
function shift(n) { const d = new Date(month.value); d.setUTCMonth(d.getUTCMonth() + n); month.value = d }
function choose(d) { emit('update:modelValue', iso(d)); open.value = false }
</script>

<template>
  <div>
    <label>{{ label }} <input readonly :value="display" placeholder="No date chosen" @click="open = true"></label>
    <button type="button" :aria-expanded="open" @click="open = !open">Choose date</button>
    <div v-if="open" class="calendar" role="dialog" :aria-label="label + ' calendar'">
      <div class="row"><button type="button" aria-label="Previous month" @click="shift(-1)">‹</button><strong aria-live="polite">{{ title }}</strong><button type="button" aria-label="Next month" @click="shift(1)">›</button></div>
      <table role="grid"><thead><tr><th v-for="d in ['Mo','Tu','We','Th','Fr','Sa','Su']" :key="d">{{ d }}</th></tr></thead>
        <tbody><tr v-for="(w, i) in weeks" :key="i"><td v-for="(d, j) in w" :key="j">
          <button v-if="d" type="button" :disabled="!usable(d)" :aria-label="d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })" :aria-pressed="modelValue === iso(d)" @click="choose(d)">{{ d.getUTCDate() }}</button>
        </td></tr></tbody></table>
      <p><small>Deliveries Monday–Saturday, until December 20.</small></p>
    </div>
  </div>
</template>
