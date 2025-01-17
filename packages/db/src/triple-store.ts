import {
  AsyncTupleDatabaseClient,
  AsyncTupleStorageApi,
  MAX,
  MIN,
  WriteOps,
  KeyValuePair,
  AsyncTupleDatabase,
  TupleStorageApi,
} from 'tuple-database';
import { Timestamp, timestampCompare } from './timestamp.js';
import MultiTupleStore, {
  MultiTupleTransaction,
  ScopedMultiTupleOperator,
  StorageScope,
} from './multi-tuple-store.js';
import { Clock } from './clocks/clock.js';
import { MemoryClock } from './clocks/memory-clock.js';
import { ValueCursor } from './query.js';
import {
  IndexNotFoundError,
  InvalidTimestampIndexScanError,
  InvalidTripleStoreValueError,
  TripleStoreOptionsError,
  TriplitError,
  WriteRuleError,
} from './errors.js';

// Value should be serializable, this is what goes into triples
// Not to be confused with the Value type we define on queries
export type Value = number | string | boolean | null;
export type EntityId = string;
export type AttributeItem = string | number;
export type Attribute = AttributeItem[];
export type Expired = boolean;
export type TenantId = string;

export type EAV = [EntityId, Attribute, Value];
export type TripleKey = [EntityId, Attribute, Value, Timestamp];
export type TripleRow = {
  id: EntityId;
  attribute: Attribute;
  value: Value;
  timestamp: Timestamp;
  expired: Expired;
};

export type TripleMetadata = { expired: Expired };

export type EAVIndex = {
  key: ['EAV', EntityId, Attribute, Value, Timestamp];
  value: TripleMetadata;
};

export type AVEIndex = {
  key: ['AVE', Attribute, Value, EntityId, Timestamp];
  value: TripleMetadata;
};

export type VAEIndex = {
  key: ['VAE', Value, Attribute, EntityId, Timestamp];
  value: TripleMetadata;
};

export type ClientTimestampIndex = {
  key: ['clientTimestamp', string, Timestamp, EntityId, Attribute, Value]; // [tenant, 'clientTimestamp', client]
  value: TripleMetadata;
};

export type MetadataIndex = {
  key: ['metadata', EntityId, ...Attribute];
  value: any;
};

type WithTenantIdPrefix<T extends KeyValuePair> = {
  key: [TenantId, ...T['key']];
  value: T['value'];
};

export type TripleIndex = EAVIndex | AVEIndex | VAEIndex | ClientTimestampIndex;
type TupleIndex = TripleIndex | MetadataIndex;
// export type TenantTripleIndex = WithTenantIdPrefix<TripleIndex>;

type MultiTupleStoreOrTransaction =
  | ScopedMultiTupleOperator<TupleIndex>
  | MultiTupleStore<TupleIndex>;

function indexToTriple(index: TupleIndex): TripleRow {
  const indexType = index.key[0];
  let e, a, v, t;
  switch (indexType) {
    case 'EAV':
      [, e, a, v, t] = index.key as EAVIndex['key'];
      break;
    case 'AVE':
      [, a, v, e, t] = index.key as AVEIndex['key'];
      break;
    // case 'VAE':
    //   [, v, a, e, t] = index.key as VAEIndex['key'];
    //   break;
    case 'clientTimestamp':
      [, , t, e, a, v] = index.key as ClientTimestampIndex['key'];
      break;
    default:
      throw new IndexNotFoundError(indexType);
  }
  return {
    id: e,
    attribute: a,
    value: v,
    timestamp: t,
    expired: index.value.expired,
  };
}

function isTupleStorage(object: any): object is AsyncTupleStorageApi {
  if (typeof object !== 'object') return false;
  const storageKeys: (keyof AsyncTupleStorageApi)[] = [
    'close',
    'commit',
    'scan',
  ];
  return storageKeys.every((objKey) => objKey in object);
}

export interface TripleStoreApi {
  // Mutation methods
  insertTriple(tripleRow: TripleRow): Promise<void>;
  insertTriples(triplesInput: TripleRow[]): Promise<void>;
  deleteTriple(tripleRow: TripleRow): Promise<void>;
  deleteTriples(triplesInput: TripleRow[]): Promise<void>;
  setValue(...value: EAV): Promise<void>;
  setValues(values: EAV[]): Promise<void>;
  expireEntity(id: EntityId): Promise<void>;
  expireEntityAttribute(id: EntityId, attribute: Attribute): Promise<void>;
  expireEntityAttributes(
    values: { id: EntityId; attribute: Attribute }[]
  ): Promise<void>;

  // Read methods
  findByCollection(
    collection: string,
    direction?: 'ASC' | 'DESC'
  ): Promise<TripleRow[]>;
  findMaxTimestamp(clientId: string): Promise<Timestamp | undefined>;
  findByClientTimestamp(
    clientId: string,
    scanDirection: 'lt' | 'lte' | 'gt' | 'gte',
    timestamp: Timestamp | undefined
  ): Promise<TripleRow[]>;

  findByEAV(
    [entityId, attribute, value]: [
      entityId?: EntityId,
      attribute?: Attribute,
      value?: Value
    ],
    direction?: 'ASC' | 'DESC'
  ): Promise<TripleRow[]>;

  findByAVE(
    [attribute, value, entityId]: [
      attribute?: Attribute,
      value?: Value,
      entityId?: EntityId
    ],
    direction?: 'ASC' | 'DESC'
  ): Promise<TripleRow[]>;

  findByEntity(id?: EntityId): Promise<TripleRow[]>;

  findByEntityAttribute(
    id: EntityId,
    attribute: Attribute
  ): Promise<TripleRow[]>;

  findByAttribute(attribute: Attribute): Promise<TripleRow[]>;

  findValuesInRange(
    attribute: Attribute,
    constraints:
      | {
          greaterThan?: ValueCursor;
          lessThan?: ValueCursor;
          direction?: 'ASC' | 'DESC';
        }
      | undefined
  ): Promise<TripleRow[]>;

  // metadata operations
  readMetadataTuples(entityId: string, attribute?: Attribute): Promise<EAV[]>;
  updateMetadataTuples(updates: EAV[]): Promise<void>;
  deleteMetadataTuples(
    deletes: [entityId: string, attribute?: Attribute][]
  ): Promise<void>;
}

type MetadataListener = (changes: {
  updates: EAV[];
  deletes: [entityId: string, attribute?: Attribute][];
}) => void | Promise<void>;

export type TripleStoreBeforeInsertHook = (
  triple: TripleRow[],
  tx: TripleStoreTransaction
) => void | Promise<void>;

export type TripleStoreBeforeCommitHook = (
  tx: TripleStoreTransaction
) => void | Promise<void>;

type TripleStoreHooks = {
  beforeInsert: TripleStoreBeforeInsertHook[];
};

// A helper class for scoping, basically what a transaction does without commit/cancel
export class TripleStoreTxOperator implements TripleStoreApi {
  parentTx: TripleStoreTransaction;
  tupleOperator: ScopedMultiTupleOperator<TupleIndex>;
  private txMetadataListeners: Set<MetadataListener> = new Set();

  readonly clock: Clock;

  hooks: TripleStoreHooks;

  constructor({
    parentTx,
    tupleOperator,
    clock,
    hooks,
  }: {
    parentTx: TripleStoreTransaction;
    tupleOperator: ScopedMultiTupleOperator<TupleIndex>;
    clock: Clock;
    hooks: TripleStoreHooks;
  }) {
    this.parentTx = parentTx;
    this.tupleOperator = tupleOperator;
    this.clock = clock;
    this.hooks = hooks;
  }

  async findByCollection(
    collection: string,
    direction?: 'ASC' | 'DESC' | undefined
  ): Promise<TripleRow[]> {
    return findByCollection(this.tupleOperator, collection, direction);
  }

  async findValuesInRange(
    attribute: Attribute,
    constraints:
      | {
          greaterThan?: ValueCursor;
          lessThan?: ValueCursor;
          direction?: 'ASC' | 'DESC';
        }
      | undefined
  ) {
    return findValuesInRange(this.tupleOperator, attribute, constraints);
  }

  async findByEAV(
    tupleArgs: [
      entityId?: string | undefined,
      attribute?: Attribute | undefined,
      value?: Value | undefined
    ],
    direction?: 'ASC' | 'DESC' | undefined
  ): Promise<TripleRow[]> {
    return findByEAV(this.tupleOperator, tupleArgs, direction);
  }
  findByAVE(
    tupleArgs: [
      attribute?: Attribute | undefined,
      value?: Value | undefined,
      entityId?: string | undefined
    ],
    direction?: 'ASC' | 'DESC' | undefined
  ): Promise<TripleRow[]> {
    return findByAVE(this.tupleOperator, tupleArgs, direction);
  }

  async findByEntity(id?: string | undefined): Promise<TripleRow[]> {
    return findByEntity(this.tupleOperator, id);
  }
  async findByEntityAttribute(
    id: string,
    attribute: Attribute
  ): Promise<TripleRow[]> {
    return findByEntityAttribute(this.tupleOperator, id, attribute);
  }
  async findByAttribute(attribute: Attribute): Promise<TripleRow[]> {
    return findByAttribute(this.tupleOperator, attribute);
  }

  findMaxTimestamp(clientId: string) {
    return findMaxTimestamp(this.tupleOperator, clientId);
  }

  findByClientTimestamp(
    clientId: string,
    scanDirection: 'lt' | 'lte' | 'gt' | 'gte' | 'eq',
    timestamp: Timestamp | undefined
  ) {
    return findByClientTimestamp(
      this.tupleOperator,
      clientId,
      scanDirection,
      timestamp
    );
  }

  async insertTriple(tripleRow: TripleRow): Promise<void> {
    await this.insertTriples([tripleRow]);
  }

  async insertTriples(triplesInput: TripleRow[]): Promise<void> {
    if (!triplesInput.length) return;
    for (const hook of this.hooks.beforeInsert) {
      await hook(triplesInput, this.parentTx);
    }
    for (const triple of triplesInput) {
      if (triple.value === undefined) {
        throw new InvalidTripleStoreValueError(undefined);
      }
      await this.addTripleToIndex(this.tupleOperator, triple);
    }
  }

  private async addTripleToIndex(
    tx: ScopedMultiTupleOperator<TupleIndex>,
    tripleInput: TripleRow
  ) {
    const { id: id, attribute, value, timestamp, expired } = tripleInput;

    // If we already have this triple, skip it (performance optimization)
    const existingTriples = await tx.scan({
      prefix: ['EAV', id, attribute, value, timestamp],
    });
    if (existingTriples.length > 1) {
      throw new TriplitError(
        'Found multiple tuples with the same key. This should not happen.'
      );
    }
    if (existingTriples.length === 1) {
      const existingTriple = indexToTriple(existingTriples[0]);
      if (existingTriple.expired === expired) {
        // console.info('Skipping index for existing triple');
        return;
      }
    }

    const metadata = { expired };

    tx.set(['EAV', id, attribute, value, timestamp], metadata);
    tx.set(['AVE', attribute, value, id, timestamp], metadata);
    // // tx.set(['VAE', value, attribute, id, timestamp], metadata);
    tx.set(
      ['clientTimestamp', timestamp[1], timestamp, id, attribute, value],
      metadata
    );
  }

  async deleteTriple(trip: TripleRow) {
    this.deleteTriples([trip]);
  }

  async deleteTriples(triples: TripleRow[]) {
    const tx = this.tupleOperator;
    for (const triple of triples) {
      const { id: id, attribute, value, timestamp } = triple;
      tx.remove(['EAV', id, attribute, value, timestamp]);
      tx.remove(['AVE', attribute, value, id, timestamp]);
      tx.remove(['VAE', value, attribute, id, timestamp]);
      tx.remove([
        'clientTimestamp',
        timestamp[1],
        timestamp,
        id,
        attribute,
        value,
      ]);
    }
  }

  async readMetadataTuples(entityId: string, attribute?: Attribute) {
    const tuples = await this.tupleOperator.scan({
      prefix: ['metadata', entityId, ...(attribute ?? [])],
    });

    return tuples.map(mapStaticTupleToEAV);
  }

  async updateMetadataTuples(updates: EAV[]) {
    for (const [entityId, attribute, value] of updates) {
      this.tupleOperator.set(['metadata', entityId, ...attribute], value);
    }
    await Promise.all(
      [...this.txMetadataListeners].map((cb) => cb({ updates, deletes: [] }))
    );
  }

  async deleteMetadataTuples(
    deletes: [entityId: string, attribute?: Attribute][]
  ) {
    for (const [entityId, attribute] of deletes) {
      (
        await this.tupleOperator.scan({
          prefix: ['metadata', entityId, ...(attribute ?? [])],
        })
      ).forEach((tuple) => this.tupleOperator.remove(tuple.key));
    }
    await Promise.all(
      [...this.txMetadataListeners].map((cb) => cb({ updates: [], deletes }))
    );
  }

  onMetadataChange(callback: MetadataListener) {
    this.txMetadataListeners.add(callback);
    return () => {
      this.txMetadataListeners.delete(callback);
    };
  }

  async setValue(id: EntityId, attribute: Attribute, value: Value) {
    return await this.setValues([[id, attribute, value]]);
  }

  async setValues(eavs: EAV[]) {
    if (!eavs.length) return;
    const txTimestamp = await this.parentTx.getTransactionTimestamp();
    const toInsert: TripleRow[] = [];
    for (const eav of eavs) {
      const [id, attribute, value] = eav;
      if (value === undefined) {
        throw new InvalidTripleStoreValueError(undefined);
      }
      const existingTriples = await this.findByEntityAttribute(id, attribute);
      const newerTriples = existingTriples.filter(
        ({ timestamp }) => timestampCompare(timestamp, txTimestamp) === 1
      );
      if (newerTriples.length === 0) {
        toInsert.push({
          id,
          attribute,
          value,
          timestamp: txTimestamp,
          expired: false,
        });
      }
    }
    await this.insertTriples(toInsert);
  }

  async expireEntity(id: EntityId) {
    const timestamp = await this.parentTx.getTransactionTimestamp();
    const collectionTriple = await this.findByEntityAttribute(id, [
      '_collection',
    ]);
    const existingTriples = await this.findByEntity(id);
    await this.insertTriples(
      collectionTriple.map((t) => ({ ...t, timestamp, expired: true }))
    );

    // Perform local garbage collection
    // Feels like it would be nice to do GC in hooks...tried once and it was a bit messy with other assumptions
    await this.deleteTriples(existingTriples);
  }

  async expireEntityAttribute(id: EntityId, attribute: Attribute) {
    return this.expireEntityAttributes([{ id, attribute }]);
  }

  async expireEntityAttributes(
    values: { id: EntityId; attribute: Attribute }[]
  ) {
    const allExistingTriples: TripleRow[] = [];
    for (const { id, attribute } of values) {
      const existingTriples = await this.findByEntityAttribute(id, attribute);
      allExistingTriples.push(...existingTriples);
    }
    const timestamp = await this.parentTx.getTransactionTimestamp();
    await this.deleteTriples(allExistingTriples);
    await this.insertTriples(
      values.map(({ id, attribute }) => ({
        id,
        attribute,
        value: null,
        timestamp,
        expired: true,
      }))
    );
  }
}

export class TripleStoreTransaction implements TripleStoreApi {
  private operator: TripleStoreTxOperator;
  tupleTx: MultiTupleTransaction<TupleIndex>;
  store: TripleStore;
  readonly clock: Clock;
  hooks: TripleStoreHooks;
  assignedTimestamp?: Timestamp;

  constructor({
    store,
    tupleTx,
    clock,
    hooks,
  }: {
    store: TripleStore;
    tupleTx: MultiTupleTransaction<TupleIndex>;
    clock: Clock;
    hooks: TripleStoreHooks;
  }) {
    this.clock = clock;
    this.hooks = hooks;
    this.operator = new TripleStoreTxOperator({
      parentTx: this,
      tupleOperator: tupleTx,
      clock,
      hooks,
    });
    this.store = store;
    this.tupleTx = tupleTx;
  }

  insertTriple(tripleRow: TripleRow): Promise<void> {
    return this.operator.insertTriple(tripleRow);
  }

  insertTriples(triplesInput: TripleRow[]): Promise<void> {
    return this.operator.insertTriples(triplesInput);
  }

  deleteTriple(tripleRow: TripleRow): Promise<void> {
    return this.operator.deleteTriple(tripleRow);
  }

  deleteTriples(triplesInput: TripleRow[]): Promise<void> {
    return this.operator.deleteTriples(triplesInput);
  }

  setValue(...value: EAV): Promise<void> {
    return this.operator.setValue(...value);
  }

  setValues(values: EAV[]): Promise<void> {
    return this.operator.setValues(values);
  }

  expireEntity(id: EntityId): Promise<void> {
    return this.operator.expireEntity(id);
  }

  expireEntityAttribute(id: EntityId, attribute: Attribute): Promise<void> {
    return this.operator.expireEntityAttribute(id, attribute);
  }

  expireEntityAttributes(
    values: { id: EntityId; attribute: Attribute }[]
  ): Promise<void> {
    return this.operator.expireEntityAttributes(values);
  }

  findByCollection(
    collection: string,
    direction?: 'ASC' | 'DESC' | undefined
  ): Promise<TripleRow[]> {
    return this.operator.findByCollection(collection, direction);
  }

  findMaxTimestamp(clientId: string): Promise<Timestamp | undefined> {
    return this.operator.findMaxTimestamp(clientId);
  }

  findByClientTimestamp(
    clientId: string,
    scanDirection: 'lt' | 'lte' | 'gt' | 'gte',
    timestamp: Timestamp | undefined
  ): Promise<TripleRow[]> {
    return this.operator.findByClientTimestamp(
      clientId,
      scanDirection,
      timestamp
    );
  }

  findByEAV(
    eav: [
      entityId?: string | undefined,
      attribute?: Attribute | undefined,
      value?: Value | undefined
    ],
    direction?: 'ASC' | 'DESC' | undefined
  ): Promise<TripleRow[]> {
    return this.operator.findByEAV(eav, direction);
  }

  findByAVE(
    ave: [
      attribute?: Attribute | undefined,
      value?: Value | undefined,
      entityId?: string | undefined
    ],
    direction?: 'ASC' | 'DESC' | undefined
  ): Promise<TripleRow[]> {
    return this.operator.findByAVE(ave, direction);
  }

  findByEntity(id?: string | undefined): Promise<TripleRow[]> {
    return this.operator.findByEntity(id);
  }

  findByEntityAttribute(
    id: string,
    attribute: Attribute
  ): Promise<TripleRow[]> {
    return this.operator.findByEntityAttribute(id, attribute);
  }

  findByAttribute(attribute: Attribute): Promise<TripleRow[]> {
    return this.operator.findByAttribute(attribute);
  }

  readMetadataTuples(
    entityId: string,
    attribute?: Attribute | undefined
  ): Promise<EAV[]> {
    return this.operator.readMetadataTuples(entityId, attribute);
  }

  updateMetadataTuples(updates: EAV[]): Promise<void> {
    return this.operator.updateMetadataTuples(updates);
  }

  deleteMetadataTuples(
    deletes: [entityId: string, attribute?: Attribute | undefined][]
  ): Promise<void> {
    return this.operator.deleteMetadataTuples(deletes);
  }

  findValuesInRange(
    attribute: Attribute,
    constraints:
      | {
          greaterThan?: ValueCursor | undefined;
          lessThan?: ValueCursor | undefined;
          direction?: 'ASC' | 'DESC' | undefined;
        }
      | undefined
  ): Promise<TripleRow[]> {
    return this.operator.findValuesInRange(attribute, constraints);
  }

  async commit(): Promise<void> {
    await this.tupleTx.commit();
  }

  async cancel(): Promise<void> {
    await this.tupleTx.cancel();
  }

  withScope(scope: StorageScope) {
    return new TripleStoreTxOperator({
      parentTx: this,
      tupleOperator: this.tupleTx.withScope(scope),
      clock: this.clock,
      hooks: this.hooks,
    });
  }

  beforeInsert(callback: TripleStoreBeforeInsertHook) {
    this.hooks.beforeInsert.push(callback);
  }

  beforeCommit(callback: TripleStoreBeforeCommitHook) {
    this.tupleTx.hooks.beforeCommit.push(() => callback(this));
  }

  async getTransactionTimestamp() {
    if (!this.assignedTimestamp) {
      this.assignedTimestamp = await this.clock.getNextTimestamp();
    }
    return this.assignedTimestamp;
  }
}

export class TripleStore implements TripleStoreApi {
  stores: Record<
    string,
    AsyncTupleDatabaseClient<WithTenantIdPrefix<TupleIndex>>
  >;
  storageScope: string[];
  tupleStore: MultiTupleStore<TupleIndex>;
  clock: Clock;
  tenantId: string;
  hooks: TripleStoreHooks;

  constructor({
    storage,
    stores,
    tenantId,
    clock,
    storageScope = [],
  }: {
    storage?:
      | (TupleStorageApi | AsyncTupleStorageApi)
      | Record<string, TupleStorageApi | AsyncTupleStorageApi>;
    stores?: Record<
      string,
      AsyncTupleDatabaseClient<WithTenantIdPrefix<TupleIndex>>
    >;
    tenantId?: string;
    storageScope?: string[];
    clock?: Clock;
  }) {
    this.hooks = {
      beforeInsert: [],
    };
    if (!stores && !storage)
      throw new TripleStoreOptionsError(
        'Must provide either storage or stores'
      );
    if (stores && storage)
      throw new TripleStoreOptionsError(
        'Cannot provide both storage and stores'
      );

    this.storageScope = storageScope;
    let normalizedStores;
    if (stores) {
      normalizedStores = stores;
    } else {
      const confirmedStorage = storage!;
      normalizedStores = isTupleStorage(confirmedStorage)
        ? {
            primary: new AsyncTupleDatabaseClient<
              WithTenantIdPrefix<TupleIndex>
            >(new AsyncTupleDatabase(confirmedStorage)),
          }
        : Object.fromEntries(
            Object.entries(confirmedStorage).map(([k, v]) => [
              k,
              new AsyncTupleDatabaseClient<WithTenantIdPrefix<TupleIndex>>(
                new AsyncTupleDatabase(v)
              ),
            ])
          );
    }
    // Server side database should provide a tenantId (project id)
    this.stores = normalizedStores;
    this.tenantId = tenantId ?? 'client';
    this.tupleStore = new MultiTupleStore<WithTenantIdPrefix<TupleIndex>>({
      storage: normalizedStores,
    }).subspace([this.tenantId]) as MultiTupleStore<TupleIndex>;

    this.clock = clock ?? new MemoryClock();
    this.clock.assignToStore(this);
  }

  beforeInsert(callback: TripleStoreBeforeInsertHook) {
    this.hooks.beforeInsert.push(callback);
  }

  findByCollection(
    collection: string,
    direction?: 'ASC' | 'DESC' | undefined
  ): Promise<TripleRow[]> {
    return findByCollection(this.tupleStore, collection, direction);
  }

  findByEAV(
    [entityId, attribute, value]: [
      entityId?: string | undefined,
      attribute?: Attribute | undefined,
      value?: Value | undefined
    ],
    direction?: 'ASC' | 'DESC' | undefined
  ): Promise<TripleRow[]> {
    return findByEAV(this.tupleStore, [entityId, attribute, value], direction);
  }
  findByAVE(
    [attribute, value, entityId]: [
      attribute?: Attribute | undefined,
      value?: Value | undefined,
      entityId?: string | undefined
    ],
    direction?: 'ASC' | 'DESC' | undefined
  ): Promise<TripleRow[]> {
    return findByAVE(this.tupleStore, [attribute, value, entityId], direction);
  }

  findByEntity(id?: string | undefined): Promise<TripleRow[]> {
    return findByEntity(this.tupleStore, id);
  }
  findByEntityAttribute(
    id: string,
    attribute: Attribute
  ): Promise<TripleRow[]> {
    return findByEntityAttribute(this.tupleStore, id, attribute);
  }
  findByAttribute(attribute: Attribute): Promise<TripleRow[]> {
    return findByAttribute(this.tupleStore, attribute);
  }

  async findValuesInRange(
    attribute: Attribute,
    constraints:
      | {
          greaterThan?: ValueCursor;
          lessThan?: ValueCursor;
          direction?: 'ASC' | 'DESC';
        }
      | undefined
  ) {
    return findValuesInRange(this.tupleStore, attribute, constraints);
  }

  findMaxTimestamp(clientId: string) {
    return findMaxTimestamp(this.tupleStore, clientId);
  }

  findByClientTimestamp(
    clientId: string,
    scanDirection: 'lt' | 'lte' | 'gt' | 'gte' | 'eq',
    timestamp: Timestamp | undefined
  ) {
    return findByClientTimestamp(
      this.tupleStore,
      clientId,
      scanDirection,
      timestamp
    );
  }

  async transact(
    callback: (tx: TripleStoreTransaction) => Promise<void>,
    scope?: Parameters<typeof this.tupleStore.transact>[0]
  ) {
    let isCanceled = false;
    const tx = await this.tupleStore.autoTransact(async (tupleTx) => {
      const tx = new TripleStoreTransaction({
        store: this,
        tupleTx: tupleTx,
        clock: this.clock,
        hooks: this.hooks,
      });
      if (isCanceled) return tx;
      try {
        await callback(tx);
      } catch (e) {
        if (e instanceof WriteRuleError) {
          isCanceled = true;
          await tx.cancel();
        }
        throw e;
      }
      return tx;
    }, scope);
    return tx.assignedTimestamp
      ? JSON.stringify(tx.assignedTimestamp)
      : undefined;
  }

  setStorageScope(storageKeys: (keyof typeof this.stores)[]) {
    return new TripleStore({
      stores: Object.fromEntries(
        Object.entries(this.stores).filter(([storagekey]) =>
          storageKeys.includes(storagekey as keyof typeof this.stores)
        )
      ),
      storageScope: storageKeys,
      tenantId: this.tenantId,
      clock: this.clock,
    });
  }

  async setValue(
    entity: string,
    attribute: Attribute,
    value: Value
  ): Promise<void> {
    await this.transact(async (tx) => {
      await tx.setValue(entity, attribute, value);
    });
  }

  async setValues(values: EAV[]): Promise<void> {
    await this.transact(async (tx) => {
      await tx.setValues(values);
    });
  }

  async expireEntity(id: string) {
    await this.transact(async (tx) => {
      await tx.expireEntity(id);
    });
  }

  async expireEntityAttribute(id: string, attribute: Attribute) {
    await this.transact(async (tx) => {
      await tx.expireEntityAttribute(id, attribute);
    });
  }

  async expireEntityAttributes(values: { id: string; attribute: Attribute }[]) {
    await this.transact(async (tx) => {
      await tx.expireEntityAttributes(values);
    });
  }

  async insertTriple(tripleRow: TripleRow) {
    await this.transact(async (tx) => {
      await tx.insertTriple(tripleRow);
    });
  }

  async insertTriples(triplesInput: TripleRow[]) {
    await this.transact(async (tx) => {
      await tx.insertTriples(triplesInput);
    });
  }

  onInsert(callback: (triples: TripleRow[]) => void) {
    function writesCallback(writes: WriteOps<TupleIndex>) {
      const { set = [] } = writes;
      if (set.length === 0) return;
      const triples = set.map((w) => indexToTriple(w));
      callback(triples);
    }
    const unsub = this.tupleStore.subscribe(
      { prefix: ['EAV'] },
      writesCallback
    );
    return () => {
      unsub();
    };
  }

  // Including this as a way to capture any change to the store
  // We need this to have outbox scoped data updates since we directly delete data now
  // This might actually be a use case for tombstones
  // This also handles rolling back on outbox deletes
  onWrite(
    callback: (writes: { inserts: TripleRow[]; deletes: TripleRow[] }) => void
  ) {
    function writesCallback(writes: WriteOps<TupleIndex>) {
      const { set = [], remove = [] } = writes;
      if (set.length === 0 && remove.length === 0) return;
      const inserts = set.map((w) => indexToTriple(w));
      const deletes = remove.map((w) =>
        //@ts-ignore
        indexToTriple({ key: w, value: { expired: false } })
      );
      callback({ inserts, deletes });
    }
    const unsub = this.tupleStore.subscribe(
      { prefix: ['EAV'] },
      writesCallback
    );
    return unsub;
  }

  async deleteTriple(triple: TripleRow) {
    await this.transact(async (tx) => {
      await tx.deleteTriples([triple]);
    });
  }

  async deleteTriples(triples: TripleRow[]) {
    await this.transact(async (tx) => {
      await tx.deleteTriples(triples);
    });
  }

  async readMetadataTuples(entityId: string, attribute?: Attribute) {
    return (
      await this.tupleStore.scan({
        prefix: ['metadata', entityId, ...(attribute ?? [])],
      })
    ).map(mapStaticTupleToEAV);
  }

  async updateMetadataTuples(updates: EAV[]) {
    await this.transact(async (tx) => {
      await tx.updateMetadataTuples(updates);
    });
  }

  async deleteMetadataTuples(
    deletes: [entityId: string, attribute?: Attribute][]
  ) {
    await this.transact(async (tx) => {
      await tx.deleteMetadataTuples(deletes);
    });
  }

  async clear() {
    await this.tupleStore.clear();
  }
}

async function scanToTriples(
  tx: MultiTupleStoreOrTransaction,
  ...scanParams: Parameters<MultiTupleStoreOrTransaction['scan']>
) {
  // @ts-ignore
  return (await tx.scan(...scanParams)).map(indexToTriple);
}

async function findByCollection(
  tx: MultiTupleStoreOrTransaction,
  collectionName: string,
  direction?: 'ASC' | 'DESC'
) {
  return scanToTriples(tx, {
    prefix: ['EAV'],
    gte: [collectionName],
    // @ts-ignore
    lt: [collectionName + MAX],
    reverse: direction === 'DESC',
  });
}

async function findByEAV(
  tx: MultiTupleStoreOrTransaction,
  [entityId, attribute, value]: [
    entityId?: EntityId,
    attribute?: Attribute,
    value?: Value
  ] = [],
  direction?: 'ASC' | 'DESC'
) {
  const scanArgs = {
    prefix: ['EAV'],
    gte: [entityId ?? MIN, attribute ?? MIN, value ?? MIN],
    // @ts-ignore
    lt: [entityId ?? MAX, [...(attribute ?? []), MAX], MAX],
    reverse: direction === 'DESC',
  };
  return scanToTriples(tx, scanArgs);
}

function findByAVE(
  tx: MultiTupleStoreOrTransaction,
  [attribute, value, entityId]: [
    attribute?: Attribute,
    value?: Value,
    entityId?: EntityId
  ] = [],
  direction?: 'ASC' | 'DESC'
) {
  return scanToTriples(tx, {
    prefix: ['AVE'],
    gte: [attribute ?? MIN, value ?? MIN, entityId ?? MIN],
    // @ts-ignore
    lt: [[...(attribute ?? []), ...(value ? [] : [MAX])], value ?? MAX, MAX],
    reverse: direction === 'DESC',
  });
}

function findValuesInRange(
  tx: MultiTupleStoreOrTransaction,
  attribute: Attribute,
  {
    greaterThan,
    lessThan,
    direction,
  }: {
    greaterThan?: ValueCursor;
    lessThan?: ValueCursor;
    direction?: 'ASC' | 'DESC';
  } = {}
) {
  const prefix = ['AVE', attribute];
  const TUPLE_LENGTH = 5;
  const scanArgs = {
    prefix,
    gt: greaterThan && [
      ...greaterThan,
      ...new Array(TUPLE_LENGTH - prefix.length - greaterThan.length).fill(MAX),
    ],
    lt: lessThan && [
      ...lessThan,
      ...new Array(TUPLE_LENGTH - prefix.length - lessThan.length).fill(MIN),
    ],
    reverse: direction === 'DESC',
  };
  return scanToTriples(tx, scanArgs);
}

// function findByVAE(
//   tx: MultiTupleStoreOrTransaction,
//   [value, attribute, entityId]: [
//     value?: Value,
//     attribute?: Attribute,
//     entityId?: EntityId
//   ] = [],
//   direction?: 'ASC' | 'DESC'
// ) {
//   return scanToTriples(tx, {
//     prefix: ['VAE'],
//     gte: [value ?? MIN, attribute ?? MIN, entityId ?? MIN],
//     // @ts-ignore
//     lt: [value ?? MAX, [...(attribute ?? []), MAX], MAX],
//     reverse: direction === 'DESC',
//   });
// }

export async function findByEntity(
  tx: MultiTupleStoreOrTransaction,
  id?: EntityId
): Promise<TripleRow[]> {
  return findByEAV(tx, [id]);
}

async function findByEntityAttribute(
  tx: MultiTupleStoreOrTransaction,
  id: EntityId,
  attribute: Attribute
): Promise<TripleRow[]> {
  return findByEAV(tx, [id, attribute]);
}

async function findByAttribute(
  tx: MultiTupleStoreOrTransaction,
  attribute: Attribute
): Promise<TripleRow[]> {
  return findByAVE(tx, [attribute]);
}

// async function findByValue(
//   tx: MultiTupleStoreOrTransaction,
//   value: Value
// ): Promise<TripleRow[]> {
//   return findByVAE(tx, [value]);
// }

function mapStaticTupleToEAV(tuple: { key: any[]; value: any }): EAV {
  const [_index, entityId, ...path] = tuple.key;
  return [entityId, path, tuple.value];
}

// NOTE: SOME WEIRD STUFF GOING ON WITH TUPLE DATABASE AND gt/lte with array prefixes
async function findByClientTimestamp(
  tx: MultiTupleStoreOrTransaction,
  clientId: string,
  scanDirection: 'lt' | 'lte' | 'gt' | 'gte' | 'eq',
  timestamp: Timestamp | undefined
) {
  const indexPrefix = ['clientTimestamp', clientId];
  if (scanDirection === 'lt') {
    if (!timestamp) return [];
    return await scanToTriples(tx, {
      prefix: indexPrefix,
      lt: [timestamp],
    });
  }
  if (scanDirection === 'lte') {
    if (!timestamp) return [];
    return await scanToTriples(tx, {
      prefix: indexPrefix,
      lte: [[...timestamp, MAX]],
    });
  }
  if (scanDirection === 'gt') {
    return scanToTriples(tx, {
      prefix: indexPrefix,
      gt: [[...(timestamp ?? []), MIN]],
    });
  }
  if (scanDirection === 'gte') {
    return scanToTriples(tx, {
      prefix: indexPrefix,
      gte: [[...(timestamp ?? [])]],
    });
  }
  if (scanDirection === 'eq') {
    if (!timestamp) return [];
    return await scanToTriples(tx, {
      prefix: indexPrefix,
      gte: [timestamp],
      lt: [[...timestamp, MAX]],
    });
  }
  throw new InvalidTimestampIndexScanError(
    `Cannot perfom a scan with direction ${scanDirection}.`
  );
}

async function findMaxTimestamp(
  tx: MultiTupleStoreOrTransaction,
  clientId: string
): Promise<Timestamp | undefined> {
  const res = (await tx.scan({
    prefix: ['clientTimestamp', clientId],
    reverse: true,
  })) as ClientTimestampIndex[];
  return res[0]?.key[2];
}

// We use the _collection tuple to indicate if an entity delete should occur
export function isTupleEntityDeleteMarker(tuple: TupleIndex) {
  // @ts-ignore TODO: need to fix to support subspaces
  const collectionMarker = tuple.key[3][0];
  return collectionMarker === '_collection' && tuple.value.expired;
}
