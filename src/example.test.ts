import {
  Entity,
  MikroORM,
  PrimaryKey,
  Property,
  OneToOne,
  PrimaryKeyProp,
  Ref,
  ref,
  LoadStrategy,
  LockMode,
} from "@mikro-orm/sqlite";

@Entity({ tableName: "attorney_profile" })
class AttorneyProfile {
  @PrimaryKey()
  id!: number;

  @Property({ nullable: true })
  bio: string | null = null;

  @OneToOne("AttorneyAddress", {
    mappedBy: "attorneyProfile",
    nullable: true,
    ref: true,
    orphanRemoval: true,
  })
  address: Ref<AttorneyAddress> | null = null;
}

@Entity({ tableName: "attorney_address" })
class AttorneyAddress {
  @OneToOne(() => AttorneyProfile, {
    inversedBy: "address",
    fieldName: "profile_id",
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

let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init({
    dbName: ":memory:",
    entities: [AttorneyProfile, AttorneyAddress],
    debug: ["query", "query-params"],
    allowGlobalContext: true,
  });
  await orm.schema.refreshDatabase();
});

afterAll(async () => {
  await orm?.close(true);
});

test("em.assign with null inside transaction creates new entity instead of removing", async () => {
  const em = orm.em.fork();

  // Setup
  const profile = em.create(AttorneyProfile, { bio: "Lawyer" });
  em.create(AttorneyAddress, {
    attorneyProfile: ref(profile),
    city: "NYC",
    state: "NY",
  });
  await em.flush();
  const profileId = profile.id;
  em.clear();

  // Bug: inside transaction, em.assign creates new entity instead of removing
  await em.transactional(async (txEm) => {
    const loaded = await txEm.findOne(
      AttorneyProfile,
      { id: profileId },
      {
        populate: ["address"],
        lockMode: LockMode.PESSIMISTIC_WRITE,
        strategy: LoadStrategy.JOINED,
      }
    );

    txEm.assign(loaded!, { address: null }, { updateByPrimaryKey: false });
    await txEm.flush();
  });

  em.clear();
  const addressAfter = await em.findOne(AttorneyAddress, {
    attorneyProfile: profileId,
  });
  expect(addressAfter).toBeNull();
});
