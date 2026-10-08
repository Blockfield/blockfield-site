import type { GunField, GunValue } from './gun-balance.ts'
import { BODY_PARTS } from './gun-fields.ts'

const labels = {
  head: 'Голова',
  torso: 'Торс',
  left_arm: 'Левая рука',
  right_arm: 'Правая рука',
  left_leg: 'Левая нога',
  right_leg: 'Правая нога',
}

export function renderBodyPartField(
  value: Record<string, GunValue> | null,
  field: GunField,
  enabled: boolean,
) {
  const root = document.createElement('details')
  root.className = 'disclosure'
  root.open = enabled
  const summary = document.createElement('summary')
  summary.textContent = `Урон по частям тела${enabled ? ' · изменено' : ''}`
  const toggle = document.createElement('input')
  toggle.type = 'checkbox'
  toggle.checked = enabled
  const edit = document.createElement('label')
  edit.className = 'check'
  edit.append(toggle, 'Изменить множители')
  const hint = document.createElement('p')
  hint.id = 'body-part-hint'
  hint.className = 'muted'
  hint.textContent =
    'Множители действуют, когда система попаданий включена на сервере. Коэффициент применяется к обычному урону оружия один раз: 1 сохраняет урон, 0 убирает его для этой части тела. Снятая отметка возвращает все коэффициенты к 1.'
  const fields = document.createElement('div')
  fields.className = 'form-grid'
  const inputs = BODY_PARTS.map((part) => {
    const group = document.createElement('div')
    group.className = 'field'
    const input = document.createElement('input')
    input.id = `body-part-${part}`
    input.type = 'number'
    input.step = 'any'
    input.min = String(field.fields![part].min)
    input.max = String(field.fields![part].max)
    input.value = String(value?.[part] ?? '')
    input.required = true
    input.disabled = !enabled
    input.setAttribute('aria-describedby', hint.id)
    const label = document.createElement('label')
    label.htmlFor = input.id
    label.textContent = labels[part]
    group.append(label, input)
    fields.append(group)
    return input
  })
  toggle.addEventListener('change', () => {
    for (const input of inputs) input.disabled = !toggle.checked
  })
  root.append(summary, edit, hint, fields)
  return {
    node: root,
    read: () => {
      if (!toggle.checked) return undefined
      return Object.fromEntries(
        inputs.map((input, index) => {
          const part = BODY_PARTS[index]
          const number = Number(input.value)
          if (
            !input.value.trim() ||
            !Number.isFinite(number) ||
            number < Number(input.min) ||
            number > Number(input.max)
          )
            throw new Error(`${labels[part]}: введите коэффициент от ${input.min} до ${input.max}.`)
          return [part, number]
        }),
      )
    },
  }
}
