export type ActivityPage = {
  items: Array<{
    id: string; memberId: string; memberName: string; siteId: string; siteName: string;
    startedAt: string; endedAt: string | null;
    departures: Array<{ detectedAt: string; confirmedAt: string | null; returnedAt: string | null }>;
  }>;
  nextCursor: string | null;
};
