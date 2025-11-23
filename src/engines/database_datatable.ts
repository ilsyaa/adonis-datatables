import { DataTableAbstract } from '../datatable_abstract.js'
import { DatabaseQueryBuilder } from '@adonisjs/lucid/database'
import Helper from '../utils/helper.js'
import { DatabaseQueryBuilderContract, Dictionary } from '@adonisjs/lucid/types/querybuilder'
import { LucidModel, ModelQueryBuilderContract } from '@adonisjs/lucid/types/model'
import lodash from 'lodash'
import collect from 'collect.js'
import { sprintf } from 'sprintf-js'
import { DateTime } from 'luxon'

export default class DatabaseDataTable extends DataTableAbstract {
  protected nullsLast: boolean = false

  protected prepared: boolean = false

  protected keepSelectBindings: boolean = false

  protected disableUserOrdering: boolean = false

  constructor(
    protected query:
      | DatabaseQueryBuilderContract<Dictionary<any, string>>
      | ModelQueryBuilderContract<LucidModel, any>
  ) {
    super()
    this.$columns = query.columns
  }

  static canCreate(source: any): boolean {
    return source instanceof DatabaseQueryBuilder
  }

  protected getConnection() {
    return this.query.knexQuery.client
  }

  protected defaultOrdering(): any {
    const self = this
    collect(this.request.orderableColumns())
      .map((orderable: Record<string, any>) => {
        orderable['name'] = self.getColumnName(orderable['column'], true)

        return orderable
      })
      .reject(
        (orderable: Record<string, any>) =>
          self.isBlacklisted(orderable['name']) && !self.hasOrderColumn(orderable['name'])
      )
      .each((orderable: Record<string, any>) => {
        const column = self.resolveRelationColumn(orderable['name'])

        if (self.hasOrderColumn(orderable['name'])) {
          self.applyOrderColumn(orderable['name'], orderable)
        } else if (self.hasOrderColumn(column)) {
          self.applyOrderColumn(column, orderable)
        } else {
          const nullsLastSql = self.getNullsLastSql(column, orderable['direction'])
          const normalSql = self.wrapColumn(column) + ' ' + orderable['direction']
          const sql = self.nullsLast ? nullsLastSql : normalSql
          self.query.orderByRaw(sql)
        }
      })
  }

  protected hasOrderColumn(column: string): boolean {
    return this.$columnDef['order'][column] !== undefined
  }

  protected applyOrderColumn(column: string, orderable: Record<string, any>): void {
    let sql = this.$columnDef['order'][column]['sql']
    if (sql === false) {
      return
    }

    if (typeof sql === 'function') {
      sql(this.query, orderable['direction'])
    } else {
      sql = sql.replace('$1', orderable['direction'])
      const bindings = this.$columnDef['order'][column]['bindings']
      this.query.orderByRaw(sql, bindings)
    }
  }

  protected getNullsLastSql(column: string, direction: string): string {
    const sql = this.config.get('datatables.nulls_last_sql', '%s %s NULLS LAST')

    return sprintf(sql, column, direction)
      .replace(':column', column)
      .replace(':direction', direction)
  }

  protected attachAppends(data: Record<string, any>): Record<string, any> {
    const appends: Record<string, any> = {}
    for (const [key, value] of Object.entries(this.appends)) {
      if (typeof value === 'function') {
        appends[key] = Helper.value(value(this.getFilteredQuery()))
      } else {
        appends[key] = value
      }
    }

    appends['disableOrdering'] = this.disableUserOrdering

    return { ...data, ...appends }
  }

  protected getColumnSearchKeyword(i: number, raw: boolean = false): string {
    const keyword = this.request.columnKeyword(i)
    if (raw || this.request.isRegex(i)) {
      return keyword
    }

    return this.setupKeyword(keyword)
  }

  protected applyFilterColumn(
    query:
      | DatabaseQueryBuilderContract<Dictionary<any, string>>
      | ModelQueryBuilderContract<LucidModel, any>,
    columnName: string,
    keyword: string
  ): void {
    query = this.getBaseQueryBuilder(query)
    const callback = this.$columnDef['filter'][columnName]['method']

    callback(query, keyword)
  }

  protected resolveRelationColumn(column: string): string {
    return column
  }

  protected compileColumnSearch(i: number, column: string, keyword: string): void {
    if (this.request.isRegex(i)) {
      this.regexColumnSearch(column, keyword)
    } else {
      this.compileQuerySearch(this.query, column, keyword, '')
    }
  }

  protected regexColumnSearch(column: string, keyword: string): void {
    column = this.wrapColumn(column)

    let sql: string = ''
    switch (this.getConnection().driverName) {
      case 'oracle':
        sql = !this.config.isCaseInsensitive()
          ? 'REGEXP_LIKE( ' + column + ' , ? )'
          : 'REGEXP_LIKE( LOWER(' + column + ") , ?, 'i' )"
        break

      case 'pgsql':
        column = this.castColumn(column)
        sql = !this.config.isCaseInsensitive() ? column + ' ~ ?' : column + ' ~* ? '
        break

      default:
        sql = !this.config.isCaseInsensitive()
          ? column + ' REGEXP ?'
          : 'LOWER(' + column + ') REGEXP ?'
        keyword = keyword.toLowerCase()
    }

    this.query.whereRaw(sql, [keyword])
  }

  protected compileQuerySearch(
    query:
      | ModelQueryBuilderContract<LucidModel, any>
      | DatabaseQueryBuilderContract<Dictionary<any, string>>,
    columnName: string,
    keyword: string,
    boolean: string = 'or'
  ): void {
    let column = this.addTablePrefix(query, columnName)
    column = this.castColumn(column)
    let sql = column + ' LIKE ?'

    if (this.config.isCaseInsensitive()) {
      sql = 'LOWER(' + column + ') LIKE ?'
    }
    const method: string = lodash.lowerFirst(`${boolean}WhereRaw`)
    ;(query as any)[method](sql, [this.prepareKeyword(keyword)])
  }

  protected compileQueryColumnControlSearch(
    query:
      | ModelQueryBuilderContract<LucidModel, any>
      | DatabaseQueryBuilderContract<Dictionary<any, string>>,
    columnName: string,
    boolean: string = 'or',
    columnControl: any
  ): void {
    let column = this.addTablePrefix(query, columnName)
    column = this.castColumn(column)
    let sql = ''
    let bindings: any = []
    const logic = columnControl['logic'] || 'equal'
    const keyword = this.config.isCaseInsensitive()
      ? columnControl['value'].toLowerCase()
      : columnControl['value']
    const type = columnControl['type']

    switch (logic) {
      case 'contains':
        sql = this.config.isCaseInsensitive() ? `LOWER(${column}) LIKE ?` : `${column} LIKE ?`
        bindings = [`%${keyword}%`]
        break
      case 'notContains':
        sql = this.config.isCaseInsensitive()
          ? `LOWER(${column}) NOT LIKE ?`
          : `${column} NOT LIKE ?`
        bindings = [`%${keyword}%`]
        break
      case 'starts':
        sql = this.config.isCaseInsensitive() ? `LOWER(${column}) LIKE ?` : `${column} LIKE ?`
        bindings = [`${keyword}%`]
        break
      case 'ends':
        sql = this.config.isCaseInsensitive() ? `LOWER(${column}) LIKE ?` : `${column} LIKE ?`
        bindings = [`%${keyword}`]
        break
      case 'equal':
        if (Helper.isDate(keyword, type)) {
          const start = DateTime.fromFormat(keyword, 'yyyy-MM-dd').startOf('day').toSQL()
          const end = DateTime.fromFormat(keyword, 'yyyy-MM-dd').endOf('day').toSQL()
          sql = `${column} BETWEEN ? AND ?`
          bindings = [start, end]
        } else if (Helper.isDateTime(keyword, type)) {
          sql = `${column} = ?`
          bindings = [DateTime.fromISO(keyword).toUTC().toSQL()]
        } else {
          sql = this.config.isCaseInsensitive() ? `LOWER(${column}) = ?` : `${column} = ?`
          bindings = [keyword]
        }
        break
      case 'notEqual':
        if (Helper.isDate(keyword, type)) {
          const start = DateTime.fromFormat(keyword, 'yyyy-MM-dd').startOf('day').toSQL()
          const end = DateTime.fromFormat(keyword, 'yyyy-MM-dd').endOf('day').toSQL()
          sql = `${column} NOT BETWEEN ? AND ?`
          bindings = [start, end]
        } else if (Helper.isDateTime(keyword, type)) {
          sql = `${column} != ?`
          bindings = [DateTime.fromISO(keyword).toUTC().toSQL()]
        } else {
          sql = this.config.isCaseInsensitive() ? `LOWER(${column}) != ?` : `${column} != ?`
          bindings = [keyword]
        }
        break
      case 'greater':
        if (Helper.isDate(keyword, type)) {
          const datetime = DateTime.fromFormat(keyword, 'yyyy-MM-dd').startOf('day').toSQL()
          sql = `${column} > ?`
          bindings = [datetime]
        } else if (Helper.isDateTime(keyword, type)) {
          sql = `${column} > ?`
          bindings = [DateTime.fromISO(keyword).toUTC().toSQL()]
        } else {
          sql = `${column} > ?`
          bindings = [keyword]
        }
        break
      case 'greaterOrEqual':
        sql = `${column} >= ?`
        bindings = [keyword]
        break
      case 'less':
        if (Helper.isDate(keyword, type)) {
          const datetime = DateTime.fromFormat(keyword, 'yyyy-MM-dd').startOf('day').toSQL()
          console.log(datetime)
          sql = `${column} < ?`
          bindings = [datetime]
        } else if (Helper.isDateTime(keyword, type)) {
          sql = `${column} < ?`
          bindings = [DateTime.fromISO(keyword).toUTC().toSQL()]
        } else {
          sql = `${column} < ?`
          bindings = [keyword]
        }
        break
      case 'lessOrEqual':
        sql = `${column} <= ?`
        bindings = [keyword]
        break
      case 'empty':
        sql = `(${column} IS NULL OR ${column} = '')`
        bindings = []
        break
      case 'notEmpty':
        sql = `(${column} IS NOT NULL AND ${column} != '')`
        bindings = []
        break
      default:
        sql = `${column} = ?`
        bindings = [keyword]
    }

    const method: string = lodash.lowerFirst(`${boolean}WhereRaw`)
    ;(query as any)[method](sql, bindings)
  }

  protected prepareKeyword(keyword: string): string {
    if (this.config.isCaseInsensitive()) {
      keyword = keyword.toLowerCase()
    }

    if (this.config.isStartsWithSearch()) {
      return `${keyword}%`
    }

    if (this.config.isWildcard()) {
      keyword = Helper.wildcardString(keyword, '%')
    }

    if (this.config.isSmartSearch()) {
      keyword = `%${keyword}%`
    }

    return keyword
  }

  protected async prepareQuery(): Promise<this> {
    if (!this.prepared) {
      this.totalRecords = await this.totalCount()

      await this.filterRecords()
      this.ordering()
      this.paginate()
    }

    this.prepared = true

    return this
  }

  protected async filterRecords(): Promise<void> {
    const initialQuery = this.query.clone()

    if (this.autoFilter && this.request.isSearchable()) {
      this.filtering()
    }

    if (typeof this.filterCallback === 'function') {
      this.filterCallback(this.query)
    }

    this.columnSearch()
    this.columnControlSearch()

    if (!this.$skipTotalRecords && this.query === initialQuery) {
      this.filteredRecords ??= this.totalRecords
    } else {
      await this.filteredCount()

      if (this.$skipTotalRecords) {
        this.totalRecords = this.filteredRecords
      }
    }
  }

  protected hasFilterColumn(columnName: string): boolean {
    return this.$columnDef['filter'][columnName] !== undefined
  }

  protected wrapColumn(column: string) {
    return Helper.wrapColumn(column, true)
  }

  protected getBaseQueryBuilder(
    instance:
      | DatabaseQueryBuilderContract<Dictionary<any, string>>
      | ModelQueryBuilderContract<LucidModel, any>
      | undefined = undefined
  ):
    | DatabaseQueryBuilderContract<Dictionary<any, string>>
    | ModelQueryBuilderContract<LucidModel, any> {
    if (!instance) {
      instance = this.query as
        | DatabaseQueryBuilderContract<Dictionary<any, string>>
        | ModelQueryBuilderContract<LucidModel, any>
    }

    return instance
  }

  protected castColumn(column: string): string {
    const driverName = this.getConnection().driverName

    switch (driverName) {
      case 'pgsql':
        return `CAST(${column} AS TEXT)`
      case 'firebird':
        return `CAST(${column} AS VARCHAR(255))`
      default:
        return column
    }
  }

  protected addTablePrefix(
    query:
      | DatabaseQueryBuilderContract<Dictionary<any, string>>
      | ModelQueryBuilderContract<LucidModel, any>,
    column: string
  ): string {
    if (!column.includes('.')) {
      const sql = this.getBaseQueryBuilder(query).toSQL().sql
      const regex = /from\s+`?(\w+)`?/ig;
      const allMatches = [...sql.matchAll(regex)];
      const lastMatch = allMatches.length > 0 ? allMatches[allMatches.length - 1] : null;
      const tableName = lastMatch ? lastMatch[1] : '';
      let from: string = tableName

      if (typeof from === 'string') {
        if (from.includes(' as ')) {
          from = from.split(' as ')[1] as string
        }
        column = `${from}.${column}`
      }
    }

    return this.wrapColumn(column)
  }

  protected getFilteredQuery():
    | DatabaseQueryBuilderContract<Dictionary<any, string>>
    | ModelQueryBuilderContract<LucidModel, any> {
    this.prepareQuery()

    return this.query
  }

  protected resolveCallback(): any {
    return this.query
  }

  async results() {
    try {
      this.prepareContext()

      const query = await this.prepareQuery()
      const results = await query.dataResults()
      const processed = this.processResults(results)

      return this.render(processed)
    } catch (error) {
      return this.errorResponse(error)
    }
  }

  async dataResults(): Promise<Record<string, any>[]> {
    return await this.query
  }

  async count(): Promise<number> {
    const builder = this.query.clone() as DatabaseQueryBuilder
    const result = await builder.exec()
    return result.length
  }

  columnSearch(): void {
    const columns = this.request.columns()

    for (let index = 0; index < columns.length; index++) {
      let column = this.getColumnName(index)

      if (column === null) {
        continue
      }

      if (
        !this.request.isColumnSearchable(index) ||
        (this.isBlacklisted(column) && !this.hasFilterColumn(column))
      ) {
        continue
      }

      if (this.hasFilterColumn(column)) {
        const keyword = this.getColumnSearchKeyword(index, true)
        this.applyFilterColumn(this.getBaseQueryBuilder(), column, keyword)
      } else {
        column = this.resolveRelationColumn(column)
        const keyword = this.getColumnSearchKeyword(index)
        this.compileColumnSearch(index, column, keyword)
      }
    }
  }

  columnControlSearch(): void {
    const columns = this.request.columns()

    for (let index = 0; index < columns.length; index++) {
      let column = this.getColumnName(index)

      if (column === null) {
        continue
      }

      if (
        !this.request.isColumnControlSearch(index) ||
        (this.isBlacklisted(column) && !this.hasFilterColumn(column))
      ) {
        continue
      }

      const columnControl: any = this.request.columnControlSearch(index)

      if (columnControl['value'] === '' || columnControl['value'] === null) {
        continue
      }

      this.compileQueryColumnControlSearch(this.query, column, 'or', columnControl)
    }
  }

  filterColumn(
    column: string,
    callback: <T extends abstract new (...args: any) => any>(
      query: InstanceType<T>,
      keyword: string
    ) => void
  ): this {
    this.$columnDef['filter'][column] = { method: callback }

    return this
  }

  orderColumns(columns: Record<string, any>, sql: string, bindings: any[] = []): this {
    for (const column of Object.values(columns)) {
      this.orderColumn(column, sql.replace(':column', column), bindings)
    }

    return this
  }

  orderColumn(
    column: string,
    sql:
      | (<T extends abstract new (...args: any) => any>(
          query: InstanceType<T>,
          direction: string
        ) => void)
      | string
      | boolean,
    bindings: any[] = []
  ): this {
    this.$columnDef['order'][column] = { sql: sql, bindings: bindings }

    return this
  }

  orderByNullsLast(): this {
    this.nullsLast = true

    return this
  }

  paging(): void {
    const start = this.request.start()
    const length = this.request.length()
    const limit = length > 0 ? length : 10

    this.query.offset(start).limit(limit)
  }

  addColumn(
    name: string,
    content:
      | (<T extends abstract new (...args: any) => any>(row: InstanceType<T>) => string | number)
      | string
      | number,
    order = false
  ): this {
    this.pushToBlacklist(name)

    return super.addColumn(name, content, order)
  }

  globalSearch(keyword: string): void {
    const self = this

    this.query.where((query: DatabaseQueryBuilder) => {
      collect(self.request.searchableColumnIndex())
        .map((index: number) => super.getColumnName(index))
        .filter(() => true)
        .reject(
          (column) =>
            self.isBlacklisted(column as string) && !self.hasFilterColumn(column as string)
        )
        .each((column) => {
          if (self.hasFilterColumn(column as string)) {
            self.applyFilterColumn(query, column as string, keyword)
          } else {
            self.compileQuerySearch(query, column as string, keyword)
          }
        })
    })
  }

  ordering(): void {
    if (this.disableUserOrdering) {
      return
    }

    super.ordering()
  }
}
