/** A reshaping step run over one org unit's policies for one section. */
export interface PolicyParser {
  parse(orgUnit: string, section: string): void;
}
