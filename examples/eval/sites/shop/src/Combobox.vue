<script setup>
// ARIA 1.2 combobox with async suggestions (listbox popup, arrow keys, Enter).
import { ref, watch } from 'vue'
const props = defineProps({ label: String, fetcher: Function, modelValue: String, name: String })
const emit = defineEmits(['update:modelValue', 'pick'])
const text = ref(props.modelValue ?? ''), options = ref([]), open = ref(false), active = ref(-1), id = 'cb-' + Math.random().toString(36).slice(2, 8)
let seq = 0
watch(text, async value => {
  emit('update:modelValue', value)
  const mine = ++seq
  const list = await props.fetcher(value)
  if (mine !== seq) return
  options.value = list; open.value = list.length > 0; active.value = -1
})
function choose(option) {
  const label = typeof option === 'string' ? option : option.name
  seq++; text.value = label; open.value = false; options.value = []
  emit('update:modelValue', label); emit('pick', option)
}
function key(e) {
  if (!open.value) return
  if (e.key === 'ArrowDown') { active.value = Math.min(options.value.length - 1, active.value + 1); e.preventDefault() }
  if (e.key === 'ArrowUp') { active.value = Math.max(0, active.value - 1); e.preventDefault() }
  if (e.key === 'Enter' && active.value >= 0) { choose(options.value[active.value]); e.preventDefault() }
  if (e.key === 'Escape') open.value = false
}
</script>

<template>
  <div class="combo">
    <label :for="id">{{ label }}</label>
    <input :id="id" :name="name" v-model="text" role="combobox" autocomplete="off" aria-autocomplete="list" :aria-expanded="open" :aria-controls="id + '-list'"
      :aria-activedescendant="active >= 0 ? `${id}-o${active}` : undefined" @keydown="key" @blur="setTimeout(() => (open = false), 150)">
    <ul v-show="open" :id="id + '-list'" role="listbox" :aria-label="label + ' suggestions'">
      <li v-for="(o, i) in options" :key="i" :id="`${id}-o${i}`" role="option" :aria-selected="i === active" @mousedown.prevent="choose(o)">{{ typeof o === 'string' ? o : o.name }}</li>
    </ul>
  </div>
</template>
