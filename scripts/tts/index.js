'use strict'

const { option } = require('../common')

const requested = option('engine', 'mlx')
const engine = requested === 'system' ? require('./system') : require('./mlx')

module.exports = { ...engine, name: requested }
