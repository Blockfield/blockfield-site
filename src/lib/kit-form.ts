import { customSelect, customCombo } from './custom-select.ts'
import { ARENA_MODES } from './game-names.ts'
import { baseKits, type KitCatalog, type KitDefinition, type KitItem } from './kit-schema.ts'

const labels: Record<string, string> = {
  gunId: 'Оружие',
  ammoId: 'Боеприпас',
  attachmentId: 'Обвес',
  throwableId: 'Граната',
  gunAmmo: 'Патронов в магазине',
  fireMode: 'Режим огня',
  bulletInBarrel: 'Патрон в стволе',
  creativeAmmo: 'Бесконечные патроны',
  armorPlate: 'Бронепластина',
  color: 'Цвет (RGB)',
  damage: 'Износ',
  initial_scout: 'Разведывательные дроны',
  initial_combat: 'Боевые дроны',
  initial_fpv: 'FPV-дроны',
  initial_fibre_fpv: 'FPV на оптоволокне',
  max_active_fpv: 'Одновременно активных FPV',
}
const teams = { RedTeam: 'Красная команда', BlueTeam: 'Синяя команда', NONE: 'Без команды' }
let sequence = 0
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, any> = {},
  ...children: (Node | string)[]
) {
  const value = document.createElement(tag)
  Object.assign(value, props)
  value.append(...children)
  return value
}
function field(name: string, input: HTMLElement, hint?: string) {
  input.id = `kit-field-${++sequence}`
  const description = hint ? node('small', { textContent: hint, id: input.id + '-hint' }) : null
  if (description) input.setAttribute('aria-describedby', description.id)
  return node(
    'div',
    { className: 'field' },
    node('label', { htmlFor: input.id, textContent: name }),
    input,
    ...(description ? [description] : []),
  )
}
function action(name: string, run: () => void) {
  return node('button', { type: 'button', className: 'small', textContent: name, onclick: run })
}
export function effectiveKits(
  catalog: KitCatalog,
  overrides: Record<string, KitDefinition>,
  classCosts: Record<string, number> = {},
) {
  return Object.fromEntries([
    ...Object.entries(baseKits(catalog, classCosts)),
    ...Object.entries(overrides),
  ])
}
export function renderKitForm(
  catalog: KitCatalog,
  original: KitDefinition,
  changed: (kit: KitDefinition) => void,
) {
  const kit = structuredClone(original),
    root = node('div', { className: 'stack' }),
    opened = new Set<string>()
  const touch = () => changed(structuredClone(kit))
  function disclosure(title: string, ...children: Node[]) {
    const key = title.replace(/\(\d+\)/g, '').replace(/: .+$/, '')
    const details = node(
      'details',
      { className: 'disclosure', open: opened.has(key) },
      node('summary', { textContent: title }),
      ...children,
    )
    details.addEventListener('toggle', () => (details.open ? opened.add(key) : opened.delete(key)))
    return details
  }
  function choice(
    title: string,
    entries: { id: string; name: string }[],
    value: string | undefined,
    set: (value: string | undefined) => void,
    optional = false,
  ) {
    if (entries.length > 128) {
      const options = new Map(entries.map((entry) => [`${entry.name} · ${entry.id}`, entry.id])),
        input = node('input', { value: value ?? '', required: !optional, autocomplete: 'off' }),
        content = field(title, input, 'Найдите по названию или ID и выберите предмет из каталога.')
      customCombo(input, [...options.keys()])
      input.addEventListener('input', () => {
        const match =
          options.get(input.value) ?? entries.find((entry) => entry.id === input.value)?.id
        input.setCustomValidity(
          match || (optional && input.value === '')
            ? ''
            : 'Выберите значение из серверного каталога.',
        )
        if (match || (optional && input.value === '')) {
          set(match)
          touch()
        }
      })
      return content
    }
    const select = node(
      'select',
      { value: value ?? '' },
      ...(optional ? [node('option', { value: '', textContent: 'По умолчанию' })] : []),
      ...entries.map((entry) =>
        node('option', {
          value: entry.id,
          textContent:
            entry.name === entry.id || entry.name.endsWith('.name')
              ? entry.id
              : `${entry.name} · ${entry.id}`,
        }),
      ),
    )
    select.value = value ?? ''
    select.addEventListener('change', () => {
      set(select.value || undefined)
      touch()
    })
    return field(title, select)
  }
  function number(
    title: string,
    key: string,
    value: number | undefined,
    set: (value: number | undefined) => void,
    optional = false,
  ) {
    const bounds = catalog.fields[key],
      input = node('input', {
        type: 'number',
        min: bounds.min,
        max: bounds.max,
        step: key === 'armorPlate' ? 'any' : 1,
        required: !optional,
        value: value === undefined ? '' : String(value),
      })
    input.addEventListener('input', () => {
      set(input.value === '' && optional ? undefined : Number(input.value))
      touch()
    })
    return field(
      title,
      input,
      `${bounds.min}…${bounds.max}${optional ? '; пусто — по умолчанию.' : ''}`,
    )
  }
  function text(title: string, value: string, set: (value: string) => void, identifier = false) {
    const input = node('input', {
      required: true,
      maxLength: identifier ? 32 : 80,
      value,
      ...(identifier ? { pattern: catalog.fields.idPattern } : {}),
    })
    input.addEventListener('input', () => {
      set(input.value)
      touch()
    })
    return field(title, input)
  }
  function itemFields(item: KitItem, accessory: boolean) {
    const content = node('div', { className: 'stack' })
    content.append(
      choice('Предмет', catalog.items, item.id, (value) => {
        item.id = value!
        if (item.id === 'tacz:modern_kinetic_gun') item.count = 1
        delete item.data
        const entries = (
          {
            'tacz:modern_kinetic_gun': ['gunId', catalog.guns],
            'tacz:ammo': ['ammoId', catalog.ammos],
            'tacz:attachment': ['attachmentId', catalog.attachments],
            'lrtactical:throwable': ['throwableId', catalog.throwables],
          } as Record<string, [string, { id: string }[]]>
        )[item.id]
        if (entries?.[1].length) item.data = { [entries[0]]: entries[1][0].id }
        paint()
      }),
      number('Количество', 'count', item.count, (value) => (item.count = value!)),
    )
    if (item.id === 'tacz:modern_kinetic_gun') {
      const count = content.querySelector<HTMLInputElement>('input[type="number"]')!
      count.max = '1'
      count.readOnly = true
      count.parentElement!.querySelector('small')!.textContent = 'Одно оружие на предмет.'
    }
    if (accessory)
      content.append(
        choice(
          'Слот аксессуара',
          catalog.accessorySlots.map((id) => ({ id, name: id })),
          item.slot,
          (value) => (item.slot = value),
        ),
        number(
          'Индекс слота',
          'index',
          item.index,
          (value) => (value === undefined ? delete item.index : (item.index = value)),
          true,
        ),
      )
    const data = item.data ?? {},
      typed = (
        {
          'tacz:modern_kinetic_gun': ['gunId', catalog.guns],
          'tacz:ammo': ['ammoId', catalog.ammos],
          'tacz:ammo_box': ['ammoId', catalog.ammos],
          'tacz:attachment': ['attachmentId', catalog.attachments],
          'lrtactical:throwable': ['throwableId', catalog.throwables],
        } as Record<string, [string, { id: string; name: string }[]]>
      )[item.id]
    const setData = (key: string, value: any) => {
      if (value === undefined) delete data[key]
      else data[key] = value
      if (Object.keys(data).length) item.data = data
      else delete item.data
    }
    if (typed)
      content.append(
        choice(
          labels[typed[0]],
          typed[1],
          data[typed[0]],
          (value) => setData(typed[0], value),
          item.id === 'tacz:ammo_box',
        ),
      )
    const metadata = node('div', { className: 'stack' })
    for (const key of ['armorPlate', 'color', 'damage'])
      metadata.append(number(labels[key], key, data[key], (value) => setData(key, value), true))
    if (item.id === 'tacz:modern_kinetic_gun') {
      metadata.append(
        number(labels.gunAmmo, 'gunAmmo', data.gunAmmo, (value) => setData('gunAmmo', value), true),
        choice(
          labels.fireMode,
          catalog.fields.fireModes.map((id: string) => ({ id, name: id })),
          data.fireMode,
          (value) => setData('fireMode', value),
          true,
        ),
      )
      for (const key of ['bulletInBarrel'])
        metadata.append(
          choice(
            labels[key],
            [
              { id: 'true', name: 'Да' },
              { id: 'false', name: 'Нет' },
            ],
            data[key] === undefined ? undefined : String(data[key]),
            (value) => setData(key, value === undefined ? undefined : value === 'true'),
            true,
          ),
        )
      for (const slot of catalog.fields.attachmentSlots as string[]) {
        const attachment = data.attachments?.[slot]
        metadata.append(
          choice(
            `Обвес ${slot}`,
            catalog.attachments,
            attachment?.id,
            (value) => {
              const attachments = data.attachments ?? {}
              if (value) attachments[slot] = { ...(attachments[slot] ?? {}), id: value }
              else delete attachments[slot]
              setData('attachments', Object.keys(attachments).length ? attachments : undefined)
              paint()
            },
            true,
          ),
        )
        if (attachment)
          metadata.append(
            number(
              `Увеличение ${slot}`,
              'zoom',
              attachment.zoom,
              (value) => (value === undefined ? delete attachment.zoom : (attachment.zoom = value)),
              true,
            ),
          )
      }
    }
    if (item.id === 'tacz:ammo_box')
      metadata.append(
        choice(
          labels.creativeAmmo,
          [
            { id: 'true', name: 'Да' },
            { id: 'false', name: 'Нет' },
          ],
          data.creativeAmmo === undefined ? undefined : String(data.creativeAmmo),
          (value) => setData('creativeAmmo', value === undefined ? undefined : value === 'true'),
          true,
        ),
      )
    content.append(disclosure('Свойства предмета', metadata))
    return content
  }
  function itemList(title: string, entries: KitItem[], accessory = false, bound = 'items') {
    const list = node('div', { className: 'stack' })
    entries.forEach((item, index) => {
      const content = node('div', { className: 'stack' }),
        details = disclosure(`${title} · ${index + 1}`, content)
      let loaded = false
      const load = () => {
        if (!loaded && details.open) {
          loaded = true
          content.append(
            itemFields(item, accessory),
            action('Выше в списке', () => {
              if (!index) return
              ;[entries[index - 1], entries[index]] = [entries[index], entries[index - 1]]
              touch()
              paint()
            }),
            action('Ниже в списке', () => {
              if (index + 1 >= entries.length) return
              ;[entries[index + 1], entries[index]] = [entries[index], entries[index + 1]]
              touch()
              paint()
            }),
            action('Удалить предмет', () => {
              entries.splice(index, 1)
              touch()
              paint()
            }),
          )
          content.querySelectorAll<HTMLSelectElement>('select').forEach(customSelect)
        }
      }
      details.addEventListener('toggle', load)
      load()
      list.append(details)
    })
    const add = action('Добавить предмет', () => {
      const first = catalog.items.find(
        (item) =>
          ![
            'tacz:modern_kinetic_gun',
            'tacz:ammo',
            'tacz:attachment',
            'lrtactical:throwable',
          ].includes(item.id),
      )
      if (!first) return
      entries.push({
        id: first.id,
        count: 1,
        ...(accessory ? { slot: catalog.accessorySlots[0] } : {}),
      })
      touch()
      paint()
    })
    add.disabled =
      entries.length >= catalog.fields[bound].max || (accessory && !catalog.accessorySlots.length)
    list.append(add)
    return disclosure(`${title} (${entries.length})`, list)
  }
  function paint() {
    const modes = node(
      'div',
      { className: 'checks' },
      ...catalog.modes.map((mode) => {
        const check = node('input', {
          type: 'checkbox',
          checked: kit.allowedModeIds.includes(mode.id),
        })
        check.addEventListener('change', () => {
          kit.allowedModeIds = check.checked
            ? [...kit.allowedModeIds, mode.id]
            : kit.allowedModeIds.filter((id) => id !== mode.id)
          touch()
        })
        return node(
          'label',
          { className: 'check' },
          check,
          ARENA_MODES[mode.id as keyof typeof ARENA_MODES] ?? mode.id,
        )
      }),
    )
    const variants = node('div', { className: 'stack' })
    kit.variants.forEach((variant, index) => {
      const remove = action('Удалить вариант', () => {
        kit.variants.splice(index, 1)
        touch()
        paint()
      })
      remove.disabled = kit.variants.length <= catalog.fields.variants.min
      variants.append(
        disclosure(
          `Вариант ${index + 1}: ${variant.name}`,
          text('ID варианта', variant.id, (value) => (variant.id = value), true),
          text('Название варианта', variant.name, (value) => (variant.name = value)),
          itemList('Предметы варианта', variant.items),
          itemList('Аксессуары варианта', (variant.curios ??= []), true, 'curios'),
          remove,
        ),
      )
    })
    const addVariant = action('Добавить вариант', () => {
      let index = kit.variants.length + 1
      while (kit.variants.some((variant) => variant.id === `variant_${index}`)) index++
      kit.variants.push({ id: `variant_${index}`, name: `Вариант ${index}`, items: [] })
      touch()
      paint()
    })
    addVariant.disabled = kit.variants.length >= catalog.fields.variants.max
    variants.append(addVariant)
    const equipment = node('div', { className: 'stack' })
    equipment.append(itemList('Общие аксессуары', (kit.curios ??= []), true, 'curios'))
    for (const [team, name] of Object.entries(teams)) {
      equipment.append(
        itemList(`Броня: ${name}`, ((kit.team_armor ??= {})[team] ??= []), false, 'team_armor'),
        itemList(
          `Аксессуары: ${name}`,
          ((kit.team_accessories ??= {})[team] ??= []),
          true,
          'curios',
        ),
      )
    }
    const drones = node('div', { className: 'stack' })
    for (const key of [
      'initial_scout',
      'initial_combat',
      'initial_fpv',
      'initial_fibre_fpv',
      'max_active_fpv',
    ]) {
      const input = node('input', {
        type: 'number',
        min: key === 'max_active_fpv' ? 1 : 0,
        max: 16,
        step: 1,
        value: kit.drone_settings?.[key] === undefined ? '' : String(kit.drone_settings[key]),
      })
      input.addEventListener('input', () => {
        const settings = kit.drone_settings ?? {}
        if (input.value === '') delete settings[key]
        else settings[key] = Number(input.value)
        if (Object.keys(settings).length) kit.drone_settings = settings
        else delete kit.drone_settings
        touch()
      })
      drones.append(
        field(labels[key], input, 'Пусто — не выдавать/использовать значение по умолчанию.'),
      )
    }
    root.replaceChildren(
      text('Название набора', kit.name, (value) => (kit.name = value)),
      node('fieldset', {}, node('legend', { textContent: 'Доступен в режимах' }), modes),
      number(
        'Стоимость выдачи',
        'deploymentCost',
        kit.deploymentCost,
        (value) => (kit.deploymentCost = value!),
      ),
      number(
        'Лимит игроков',
        'playerLimit',
        kit.playerLimit,
        (value) => (kit.playerLimit = value!),
      ),
      number('Ячейка ножа (0–7)', 'knifeSlot', kit.knifeSlot, (value) => (kit.knifeSlot = value!)),
      disclosure('Варианты снаряжения', variants),
      disclosure('Броня и аксессуары', equipment),
      disclosure('Дроны', drones),
    )
    root.querySelectorAll<HTMLSelectElement>('select').forEach(customSelect)
  }
  paint()
  return root
}
