/**
 * @hyphae/people
 *
 * Identity + relationship layer shared across the hyphae app suite.
 *
 * Two namespaces:
 *   - social.hyphae.identity   → your *own* published self-description
 *                                (public, fetchable from your profile room)
 *   - social.hyphae.contacts   → your *private* relationship records
 *                                about other people (notes, tags, app_data,
 *                                preferred-nickname pointer)
 *
 * Rule: every name shown in any hyphae app must be authored by the person
 * it refers to. You can prefer one of their published nicknames over another;
 * you cannot create new names for them.
 *
 * Phase 0 status: type shapes only. Implementations land in Phase 4.5
 * once hmail's read+write paths are wired and we have a real Matrix client
 * to hang the API off of.
 */

export interface Identity {
  /** The person's own primary name. They author it. */
  primary_name: string;
  /** Additional names they publish for themselves. */
  nicknames: string[];
  pronouns?: string;
  bio?: string;
  links?: { label: string; url: string }[];
  /** Visibility scope for this profile. */
  visible_to?: "everyone" | "shared_rooms" | "explicit_list";
  updated_ts: number;
}

export interface Contact {
  /** Always the canonical key. */
  mxid: string;
  /** Your private notes about your relationship with them. */
  notes?: string;
  /** Your private tags for organising them in your suite. */
  tags?: string[];
  /** Starred in your contacts list. */
  starred?: boolean;
  /**
   * Pointer to one of *their* published nicknames that you prefer to see.
   * Must exist in their current Identity.nicknames or .primary_name; if it
   * stops existing, displayName falls through to the next resolver step.
   */
  preferred_nickname?: string;
  /** When you added them. */
  added_ts: number;
  updated_ts: number;
  /** App-namespaced relationship data. Each app writes only its own slot. */
  app_data?: Record<string, Record<string, unknown>>;
}

export interface Group {
  name: string;
  members: string[];
  color?: string;
}

/**
 * Resolve an MXID to the best display string available, using only names
 * the person has authored about themselves.
 *
 * Priority:
 *   1. preferred_nickname (if user picked one and it's still published)
 *   2. their published primary_name (from social.hyphae.identity)
 *   3. their Matrix profile display_name
 *   4. their MXID localpart
 *   5. their MXID
 */
export type DisplayNameResolver = (mxid: string) => string;

/**
 * The library surface. Implementations land in Phase 4.5; this type
 * lets consumers (hmail, future Khora/Amino integrations) write against
 * a stable shape now.
 */
export interface PeopleLibrary {
  // Identity (your own)
  me: {
    get: () => Promise<Identity>;
    update: (fields: Partial<Identity>) => Promise<void>;
    addNickname: (name: string) => Promise<void>;
    removeNickname: (name: string) => Promise<void>;
  };

  // Identity (others')
  identity: (mxid: string) => Promise<Identity | null>;
  displayName: DisplayNameResolver;

  // Contacts (your private relationship records)
  contacts: {
    get: (mxid: string) => Contact | null;
    list: (filter?: { tag?: string; starred?: boolean }) => Contact[];
    add: (mxid: string, fields?: Partial<Contact>) => Promise<Contact>;
    update: (mxid: string, fields: Partial<Contact>) => Promise<Contact>;
    tag: (mxid: string, tag: string) => Promise<void>;
    untag: (mxid: string, tag: string) => Promise<void>;
    /** Must reference a name in their published Identity. */
    preferNickname: (mxid: string, name: string) => Promise<void>;
    remove: (mxid: string) => Promise<void>;
    appData: (mxid: string, app: string) => Record<string, unknown>;
    setAppData: (
      mxid: string,
      app: string,
      data: Record<string, unknown>,
    ) => Promise<void>;
  };

  // Groups
  groups: {
    list: () => Group[];
    create: (name: string, members?: string[]) => Promise<Group>;
    addMember: (groupName: string, mxid: string) => Promise<void>;
    removeMember: (groupName: string, mxid: string) => Promise<void>;
    delete: (groupName: string) => Promise<void>;
  };

  // Reactive
  subscribe: (callback: (contacts: Contact[]) => void) => () => void;
}

/**
 * Stub resolver used by hmail Phase 0 mock data. Returns the localpart
 * of the MXID. The real resolver (Phase 4.5) walks the priority chain
 * defined above against live Matrix profile + identity data.
 */
export const stubDisplayName: DisplayNameResolver = (mxid: string) => {
  const match = mxid.match(/^@([^:]+):/);
  return match ? match[1] : mxid;
};
