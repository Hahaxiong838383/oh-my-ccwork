function cell(value) {
  const text = value === null || value === undefined
    ? ''
    : typeof value === 'string'
      ? value
      : JSON.stringify(value)
  return `"${text.replaceAll('"', '""')}"`
}

export function rowsToCsv(headers, rows) {
  return `\uFEFF${headers.map(cell).join(',')}\n${rows.map((row) => headers.map((header) => cell(row[header])).join(',')).join('\n')}\n`
}

export function parseCsv(input) {
  if (typeof input !== 'string') throw new TypeError('CSV input must be a string')
  const text = input.startsWith('\uFEFF') ? input.slice(1) : input
  const records = []
  let record = []
  let field = ''
  let quoted = false
  let quoteClosed = false

  const finishField = () => {
    record.push(field)
    field = ''
    quoteClosed = false
  }
  const finishRecord = () => {
    finishField()
    records.push(record)
    record = []
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
          quoteClosed = true
        }
      } else {
        field += character
      }
      continue
    }

    if (quoteClosed && character !== ',' && character !== '\n' && character !== '\r') {
      throw new Error(`invalid character after closing quote at offset ${index}`)
    }
    if (character === '"') {
      if (field.length > 0) throw new Error(`unexpected quote at offset ${index}`)
      quoted = true
    } else if (character === ',') {
      finishField()
    } else if (character === '\n') {
      finishRecord()
    } else if (character === '\r') {
      if (text[index + 1] === '\n') index += 1
      finishRecord()
    } else {
      field += character
    }
  }

  if (quoted) throw new Error('unterminated quoted CSV field')
  if (field.length > 0 || record.length > 0 || quoteClosed) finishRecord()
  while (records.length > 0 && records.at(-1).every((value) => value === '')) records.pop()
  if (records.length === 0) throw new Error('CSV must contain a header row')

  const headers = records.shift()
  if (headers.some((header) => !header.trim())) throw new Error('CSV headers must be non-empty')
  if (new Set(headers).size !== headers.length) throw new Error('CSV headers must be unique')

  const rows = records.map((values, index) => {
    if (values.length !== headers.length) {
      throw new Error(`CSV row ${index + 2} has ${values.length} cells; expected ${headers.length}`)
    }
    return Object.fromEntries(headers.map((header, column) => [header, values[column]]))
  })
  return { headers, rows }
}

export function assertCsvHeaders(actualHeaders, expectedHeaders) {
  const actual = new Set(actualHeaders)
  const missing = expectedHeaders.filter((header) => !actual.has(header))
  const unexpected = actualHeaders.filter((header) => !expectedHeaders.includes(header))
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`CSV headers mismatch; missing=[${missing.join(', ')}] unexpected=[${unexpected.join(', ')}]`)
  }
}

export function parseJsonCell(value, fieldName, options = {}) {
  if (value === '') {
    if (Object.hasOwn(options, 'emptyValue')) return structuredClone(options.emptyValue)
    return null
  }
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new Error(`${fieldName} must contain valid JSON: ${error.message}`)
  }
}

export function parseNullableInteger(value, fieldName) {
  if (value === '') return null
  if (!/^-?\d+$/.test(value)) throw new Error(`${fieldName} must be an integer or blank`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${fieldName} must be a safe integer`)
  return parsed
}

export function parseNullableNumber(value, fieldName) {
  if (value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${fieldName} must be a finite number or blank`)
  return parsed
}

export function nullableString(value) {
  return value === '' ? null : value
}
