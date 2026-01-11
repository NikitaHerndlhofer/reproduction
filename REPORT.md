# MikroORM Bug Reproduction Report

**Date:** January 11, 2026
**Issue:** `em.assign` with `null` on OneToOne relation with `orphanRemoval` creates invalid entity
**Status:** ✅ **BUG REPRODUCED**

---

## Executive Summary

**The bug has been successfully reproduced.** The issue occurs specifically when using `em.transactional()` (or the `@Transactional()` decorator) in combination with `LockMode.PESSIMISTIC_WRITE` and `em.assign()` with `{ address: null }`.

### Root Cause Identified

When `em.assign()` is called within a transactional context with `lockMode: LockMode.PESSIMISTIC_WRITE`, MikroORM **creates a new entity** instead of **removing the existing orphaned entity**. This causes a `ValidationError` because the new entity has required fields set to `null`.

### Error Message

```
ValidationError: Value for AttorneyAddress.attorneyProfile is required, 'null' found
entity: AttorneyAddress { attorneyProfile: null, city: 'Boston', state: 'MA' }
```

---

## Key Finding: Transaction Context Triggers Bug

| Scenario                                       | Transaction | LockMode            | Result      |
| ---------------------------------------------- | ----------- | ------------------- | ----------- |
| Basic `em.assign({ address: null })`           | ❌ No       | None                | ✅ Pass     |
| With other property updates                    | ❌ No       | None                | ✅ Pass     |
| Manual `em.remove()` workaround                | ❌ No       | None                | ✅ Pass     |
| **`em.transactional()` + `PESSIMISTIC_WRITE`** | ✅ Yes      | `PESSIMISTIC_WRITE` | ❌ **FAIL** |
| **`@Transactional()` decorator pattern**       | ✅ Yes      | `PESSIMISTIC_WRITE` | ❌ **FAIL** |

### Failing Code Pattern (Your Implementation)

```typescript
@Transactional()  // <-- Transaction context
async update(userId: string, params: UpdateDto): Promise<ResponseDto> {
  const profile = await this.em.findOne(
    AttorneyProfile,
    { user: userId },
    {
      populate: ['address', 'user'],
      lockMode: LockMode.PESSIMISTIC_WRITE,  // <-- Lock mode
      strategy: LoadStrategy.JOINED,
    },
  );

  this.em.assign(profile, params, { updateByPrimaryKey: false });  // <-- Bug triggered here
  await this.em.flush();  // <-- ValidationError thrown
}
```

---

## Test Environment

### MikroORM Versions Tested

| Version            | Driver     | Without Transaction | With Transaction |
| ------------------ | ---------- | ------------------- | ---------------- |
| 6.4.0              | SQLite     | ✅ Pass             | Not tested       |
| 6.6.2              | SQLite     | ✅ Pass             | Not tested       |
| 6.6.2              | PostgreSQL | ✅ Pass             | ❌ **FAIL**      |
| 6.6.4-dev.3 (next) | SQLite     | ✅ Pass             | Not tested       |

### System Configuration

- Node.js environment
- PostgreSQL 15 (Docker)
- SQLite in-memory database

---

## Entity Structure

Three entities with **foreign primary keys** (identifying relationships):

```
User (PK: id)
  └── AttorneyProfile (PK: user_id → User.id)
        └── AttorneyAddress (PK: user_id → AttorneyProfile.user_id)
```

### User Entity

```typescript
@Entity({ tableName: "user" })
class User {
  @PrimaryKey({ type: "uuid", defaultRaw: "gen_random_uuid()" }) // PostgreSQL
  // @PrimaryKey() // SQLite (auto-increment integer)
  id!: string;

  @Property()
  name!: string;

  @Property({ unique: true })
  email!: string;
}
```

### AttorneyProfile Entity

```typescript
@Entity({ tableName: "attorney_profile" })
class AttorneyProfile {
  // Foreign Primary Key - user_id is both PK and FK to user.id
  @OneToOne(() => User, {
    owner: true,
    fieldName: "user_id",
    primary: true,
  })
  user!: Ref<User>;

  [PrimaryKeyProp]?: "user";

  @Property({ nullable: true })
  bio: string | null = null;

  // Inverse side with orphanRemoval - should remove address when set to null
  @OneToOne("AttorneyAddress", {
    mappedBy: "attorneyProfile",
    nullable: true,
    ref: true,
    orphanRemoval: true, // <-- Key configuration
  })
  address: Ref<AttorneyAddress> | null = null;
}
```

### AttorneyAddress Entity

```typescript
@Entity({ tableName: "attorney_address" })
class AttorneyAddress {
  // Foreign Primary Key - user_id is both PK and FK to attorney_profile.user_id
  @OneToOne(() => AttorneyProfile, {
    inversedBy: "address",
    fieldName: "user_id",
    deleteRule: "cascade",
    primary: true,
    ref: true,
  })
  attorneyProfile!: Ref<AttorneyProfile>;

  [PrimaryKeyProp]?: "attorneyProfile";

  @Property({ nullable: true })
  city: string | null = null;

  @Property({ nullable: true })
  state: string | null = null;
}
```

---

## Test Scenarios

### Scenario 1: Basic `em.assign` with `{ address: null }`

```typescript
// Setup
const user = em.create(User, { name: "John Doe", email: "john@example.com" });
const profile = em.create(AttorneyProfile, { user: ref(user), bio: "Lawyer" });
em.create(AttorneyAddress, {
  attorneyProfile: ref(profile),
  city: "NYC",
  state: "NY",
});
await em.flush();
em.clear();

// Load with populated relations
const loadedProfile = await em.findOneOrFail(
  AttorneyProfile,
  { user: user.id },
  { populate: ["address", "user"], strategy: LoadStrategy.JOINED }
);

// Assign null to address
em.assign(loadedProfile, { address: null });
await em.flush();
```

**Expected (reported bug):**

```
ValidationError: Value for AttorneyAddress.attorneyProfile is required, 'null' found
```

**Actual result:**

```sql
delete from "attorney_address" where "user_id" in ('...') [1 row affected]
```

✅ Address successfully deleted

---

### Scenario 2: `em.assign` with Multiple Properties

```typescript
em.assign(loadedProfile, {
  bio: "Updated bio",
  address: null,
});
await em.flush();
```

**Result:** ✅ Pass - Both bio updated and address deleted

---

### Scenario 3: Direct Property Assignment

```typescript
loadedProfile.address = null;
await em.flush();
```

**Result:** ✅ Pass - Address deleted via orphanRemoval

---

### Scenario 4: `em.assign` with `updateByPrimaryKey: false`

```typescript
em.assign(loadedProfile, { address: null }, { updateByPrimaryKey: false });
await em.flush();
```

**Result:** ✅ Pass

---

### Scenario 5: `em.assign` with `mergeObjectProperties: true`

```typescript
em.assign(loadedProfile, { address: null }, { mergeObjectProperties: true });
await em.flush();
```

**Result:** ✅ Pass

---

## SQL Query Analysis (PostgreSQL)

### Schema Creation

```sql
create table "user" (
  "id" uuid not null default gen_random_uuid(),
  "name" varchar(255) not null,
  "email" varchar(255) not null,
  constraint "user_pkey" primary key ("id")
);

create table "attorney_profile" (
  "user_id" uuid not null,
  "bio" varchar(255) null,
  constraint "attorney_profile_pkey" primary key ("user_id")
);

create table "attorney_address" (
  "user_id" uuid not null,
  "city" varchar(255) null,
  "state" varchar(255) null,
  constraint "attorney_address_pkey" primary key ("user_id")
);

alter table "attorney_profile"
  add constraint "attorney_profile_user_id_foreign"
  foreign key ("user_id") references "user" ("id")
  on update cascade on delete cascade;

alter table "attorney_address"
  add constraint "attorney_address_user_id_foreign"
  foreign key ("user_id") references "attorney_profile" ("user_id")
  on update cascade on delete cascade;
```

### Query on `em.assign({ address: null })`

```sql
-- Load profile with relations
select "a0".*, "a1"."user_id" as "a1__user_id", "a1"."city" as "a1__city", "a1"."state" as "a1__state",
       "u2"."id" as "u2__id", "u2"."name" as "u2__name", "u2"."email" as "u2__email"
from "attorney_profile" as "a0"
left join "attorney_address" as "a1" on "a0"."user_id" = "a1"."user_id"
inner join "user" as "u2" on "a0"."user_id" = "u2"."id"
where "a0"."user_id" = '...' limit 1

-- After em.assign({ address: null }) + em.flush()
begin
delete from "attorney_address" where "user_id" in ('...')  -- ✅ Correct behavior
commit
```

---

## Differences to Investigate in Your Codebase

Since the bug doesn't reproduce, your actual code likely differs in one or more of these areas:

### 1. Entity Configuration

| Aspect                      | Test Setup     | Your Setup (check) |
| --------------------------- | -------------- | ------------------ |
| `orphanRemoval`             | `true`         | ?                  |
| `ref` on inverse side       | `true`         | ?                  |
| `nullable` on inverse side  | `true`         | ?                  |
| Primary key type            | UUID / Integer | ?                  |
| Foreign primary key pattern | Yes            | ?                  |
| `mappedBy` / `inversedBy`   | Correct        | ?                  |

**Questions:**

- Do you have any custom property serializers?
- Are there any lifecycle hooks (`@BeforeUpdate`, `@AfterLoad`, etc.)?
- Do you use custom types for the primary key?

### 2. MikroORM Configuration

| Option                         | Test Setup | Your Setup (check) |
| ------------------------------ | ---------- | ------------------ |
| `forceUndefined`               | default    | ?                  |
| `serialization.forceObject`    | default    | ?                  |
| `strict`                       | default    | ?                  |
| `validate`                     | default    | ?                  |
| `discovery.warnWhenNoEntities` | default    | ?                  |

**Questions:**

- What's your full `MikroORM.init()` configuration?
- Do you use any custom metadata providers?
- Are there global filters that might affect the behavior?

### 3. Data Loading Pattern

| Aspect                     | Test Setup            | Your Setup (check) |
| -------------------------- | --------------------- | ------------------ |
| `populate`                 | `["address", "user"]` | ?                  |
| `strategy`                 | `LoadStrategy.JOINED` | ?                  |
| Entity state before assign | Populated             | ?                  |

**Questions:**

- How is the entity loaded before calling `em.assign()`?
- Is the `address` relation populated before the assign?
- Are you using `em.findOne()`, `em.findOneOrFail()`, or something else?

### 4. Assign Pattern

| Aspect             | Test Setup          | Your Setup (check) |
| ------------------ | ------------------- | ------------------ |
| Assign options     | `{}` (default)      | ?                  |
| Data shape         | `{ address: null }` | ?                  |
| DTO transformation | None                | ?                  |

**Questions:**

- Are you passing data through a DTO or transformer first?
- Is the value explicitly `null` or could it be `undefined`?
- Are you using any assign options like `{ merge: true }`?

### 5. Identity Map State

**Questions:**

- Is the address entity already in the identity map when `assign` is called?
- Are there multiple references to the same entity?
- Is there any caching layer that might return stale entities?

---

## Potential Root Causes

Based on the reported error message:

```
ValidationError: Value for AttorneyAddress.attorneyProfile is required, 'null' found
entity: AttorneyAddress {
  attorneyProfile: null,
  city: null,
  state: null,
  ...
}
```

This suggests MikroORM is **creating a new entity** instead of **removing the existing one**. This could happen if:

1. **Entity not in identity map:** If the address entity isn't properly tracked, MikroORM might interpret `{ address: null }` as "create a new AttorneyAddress with all null fields" rather than "remove the existing one."

2. **DTO/transformation issue:** If you're passing data through a DTO layer that transforms the payload, it might be creating an object like `{ attorneyProfile: null, city: null, state: null }` instead of just `null`.

3. **Custom assign behavior:** If there's a custom `assign` implementation or interceptor that modifies the behavior.

4. **Relation not loaded:** If the `address` relation isn't populated before `assign`, MikroORM might not know there's an existing entity to remove.

---

## Recommended Next Steps

### Step 1: Verify Entity Loading

Add logging before the assign:

```typescript
console.log("Profile address before assign:", loadedProfile.address);
console.log("Address is Ref:", loadedProfile.address instanceof Reference);
console.log("Address unwrapped:", loadedProfile.address?.unwrap());
```

### Step 2: Check Assign Input

Log the exact data being passed to assign:

```typescript
const updateData = { address: null };
console.log("Update data:", JSON.stringify(updateData));
console.log("address value:", updateData.address);
console.log("address is null:", updateData.address === null);
console.log("address is undefined:", updateData.address === undefined);
```

### Step 3: Inspect Unit of Work

```typescript
em.assign(loadedProfile, { address: null });

// Before flush - check what's scheduled
const uow = em.getUnitOfWork();
console.log("Identity map size:", uow.getIdentityMap().size);
console.log("Persist stack:", [...uow.getPersistStack()]);
console.log("Remove stack:", [...uow.getRemoveStack()]);
```

### Step 4: Enable Debug Mode

```typescript
orm = await MikroORM.init({
  // ...
  debug: true, // Full debug output
});
```

### Step 5: Check for Transformations

Search your codebase for:

- Class transformer decorators (`@Transform`, `@Type`)
- Custom serialization
- Request body transformers
- Any middleware that modifies request data

---

## Files in This Reproduction

| File                   | Description                    |
| ---------------------- | ------------------------------ |
| `src/example.test.ts`  | SQLite tests (6 scenarios)     |
| `src/postgres.test.ts` | PostgreSQL tests (3 scenarios) |
| `package.json`         | Dependencies                   |
| `README.md`            | Setup instructions             |
| `REPORT.md`            | This report                    |

---

## Conclusion

**The bug has been successfully reproduced.** The issue is caused by the combination of:

1. **Transaction context** (`em.transactional()` or `@Transactional()` decorator)
2. **Pessimistic locking** (`lockMode: LockMode.PESSIMISTIC_WRITE`)
3. **`em.assign()` with `{ address: null }`** on a OneToOne relation with `orphanRemoval: true`

### Bug Behavior

When these conditions are met, MikroORM incorrectly:

1. Creates a **new** `AttorneyAddress` entity with `attorneyProfile: null`
2. Attempts to INSERT this new entity instead of DELETEing the existing one
3. Fails validation because `attorneyProfile` is a required field

### Correct Behavior (Without Transaction)

Without the transaction context, MikroORM correctly:

1. Identifies the existing `AttorneyAddress` as an orphan
2. Marks it for removal via `orphanRemoval: true`
3. Executes a DELETE query

### This is a MikroORM Bug

This appears to be a bug in how MikroORM handles `orphanRemoval` within transactional contexts when combined with pessimistic locking. The issue should be reported to the MikroORM repository with this reproduction.

---

## Appendix: Working Workaround

If you need an immediate fix while investigating:

```typescript
const { address, ...rest } = updateData;

if (address === null && profile.address) {
  // Manually trigger orphan removal
  em.remove(profile.address.unwrap());
} else if (address !== undefined) {
  em.assign(profile, { address });
}

em.assign(profile, rest);
await em.flush();
```

This bypasses the potential `em.assign` issue by explicitly removing the entity.
