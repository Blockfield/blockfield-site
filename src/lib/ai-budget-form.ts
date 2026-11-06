import { usdAmount, usdMicros, type AiLimits } from './ai-budget.ts'
import { customSelect } from './custom-select.ts'

export type BudgetTarget = { id: string; name: string }

export function renderAiBudgetForm(
  policy: AiLimits,
  targets: { session?: BudgetTarget; builders: BudgetTarget[] },
) {
  const draft = structuredClone(policy)
  const form = document.createElement('form')
  form.className = 'form-grid'
  function field(id: string, title: string, input: HTMLElement) {
    const group = document.createElement('div')
    group.className = 'field'
    input.id = id
    const label = document.createElement('label')
    label.htmlFor = id
    label.textContent = title
    group.append(label, input)
    form.append(group)
    return label
  }
  function option(value: string, title: string) {
    const node = document.createElement('option')
    node.value = value
    node.textContent = title
    return node
  }
  const mode = document.createElement('select')
  mode.append(option('session', 'Общий для сеанса'), option('builder', 'Для каждого строителя'))
  mode.value = draft.mode
  field('ai-budget-mode', 'Как ограничивать расходы', mode)
  const target = document.createElement('select')
  const targetLabel = field('ai-budget-target', 'Сеанс', target)
  const amount = document.createElement('input')
  amount.type = 'text'
  amount.inputMode = 'decimal'
  amount.maxLength = 32
  amount.autocomplete = 'off'
  amount.setAttribute('aria-describedby', 'ai-budget-hint')
  field('ai-budget-amount', 'Лимит расходов, USD', amount)
  const hint = document.createElement('p')
  hint.id = 'ai-budget-hint'
  hint.className = 'muted'
  hint.textContent =
    'Полный лимит включает уже потраченное. 0 запрещает запросы. Перед генерацией нужен запас на максимальную стоимость. Персональный расход сохраняется между сеансами; смена режима и повторная выдача лимита его не сбрасывают. Администраторы используют тот же бюджет.'
  const error = document.createElement('p')
  error.className = 'form-status'
  error.role = 'status'
  const save = document.createElement('button')
  save.type = 'submit'
  save.className = 'primary'
  save.textContent = 'Сохранить бюджет AI'
  form.append(hint, error, save)
  let selected = '',
    scope = draft.mode
  const accounts = () => (scope === 'session' ? draft.sessions : draft.builders)
  function collect() {
    if (selected) {
      const micros = usdMicros(amount.value)
      if (micros || Object.hasOwn(accounts(), selected)) accounts()[selected] = micros
    }
  }
  function selectTarget() {
    selected = target.value
    amount.disabled = !selected
    amount.required = !!selected
    amount.value = selected ? usdAmount(accounts()[selected] ?? 0) : ''
  }
  function renderTargets() {
    targetLabel.textContent = scope === 'session' ? 'Сеанс' : 'Участник мастерской'
    const choices =
      scope === 'session' ? (targets.session ? [targets.session] : []) : targets.builders
    target.replaceChildren(...choices.map((entry) => option(entry.id, entry.name)))
    target.disabled = !choices.length
    if (!choices.length)
      target.append(
        option('', scope === 'session' ? 'Активный сеанс не подтверждён' : 'Участников пока нет'),
      )
    selectTarget()
  }
  mode.addEventListener('change', () => {
    try {
      collect()
      scope = mode.value as AiLimits['mode']
      draft.mode = scope
      renderTargets()
      customSelect(target)
      error.textContent = ''
    } catch (caught) {
      mode.value = scope
      error.textContent = (caught as Error).message
      error.className = 'form-status error'
    }
  })
  target.addEventListener('change', () => {
    const previous = selected
    try {
      collect()
      selectTarget()
      error.textContent = ''
    } catch (caught) {
      target.value = previous
      error.textContent = (caught as Error).message
      error.className = 'form-status error'
    }
  })
  renderTargets()
  return {
    node: form,
    saved: (revision: number, cpRevisions?: Record<string, number>) => {
      draft.revision = revision
      if (cpRevisions)
        (draft as unknown as { cpRevisions?: Record<string, number> }).cpRevisions = cpRevisions
    },
    read: () => {
      collect()
      return {
        expectedRevision: draft.revision,
        ...(() => {
          const carried = (draft as unknown as { cpRevisions?: Record<string, number> }).cpRevisions
          return carried && Object.keys(carried).length ? { cpRevisions: carried } : {}
        })(),
        mode: draft.mode,
        sessions: { ...draft.sessions },
        builders: { ...draft.builders },
      }
    },
  }
}
