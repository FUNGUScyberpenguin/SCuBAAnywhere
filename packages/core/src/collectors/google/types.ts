/** Shapes returned by Google's Policy and Directory APIs. */

export interface RawPolicy {
  name?: string;
  customer?: string;
  policyQuery: {
    query?: string;
    /** `orgUnits/{id}`. Absent means the policy applies to the top org unit. */
    orgUnit?: string;
    /** `groups/{id}`, or occasionally a bare Google-defined name. */
    group?: string;
    sortOrder: number;
  };
  setting: {
    /** `settings/<section>`, with dots where the Rego expects underscores. */
    type: string;
    value: Record<string, unknown>;
  };
}

export interface OrgUnitInfo {
  name: string;
  path: string;
}

/** Google org unit id (without the `id:` prefix) to its name and path. */
export type OrgUnitMap = Record<string, OrgUnitInfo>;

/** Google group id to the group's email address, which is unique. */
export type GroupMap = Record<string, string>;

/** Settings for one org unit, keyed by section. This is `input.policies`. */
export type OrgUnitPolicies = Record<string, unknown>;

export type ReducedPolicies = Record<string, OrgUnitPolicies>;
