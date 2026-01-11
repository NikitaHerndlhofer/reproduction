# MikroORM Bug: `em.assign` with `null` on OneToOne + `orphanRemoval` inside transaction

## Summary

When using `em.assign()` to set a OneToOne relation with `orphanRemoval: true` to `null` **inside a transaction**, MikroORM creates a new entity instead of removing the existing one.

## Version

- `@mikro-orm/core`: 6.6.2
- `@mikro-orm/sqlite`: 6.6.2

## Run

```bash
npm install
npm test
```

## Expected

```sql
DELETE from attorney_address WHERE profile_id = ?
```

## Actual

```
ValidationError: Value for AttorneyAddress.attorneyProfile is required, 'null' found
entity: AttorneyAddress { attorneyProfile: null, city: 'NYC', state: 'NY' }
```

## Workaround

```typescript
if (profile.address) {
  txEm.remove(profile.address.unwrap());
}
```
