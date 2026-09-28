package schedule

import "time"

const freeQuotaAdmissionThresholdPercent int64 = 80
const freeQuotaD1ReadAdmissionThresholdPercent int64 = 50
const quotaSnapshotMaximumAge = 3 * time.Hour

// FreeQuotaUsage contains only numeric account or resource totals from
// Cloudflare's aggregate usage dashboards. It intentionally has no fields for
// credentials or schedule data.
type FreeQuotaUsage struct {
	WorkerRequestsPerDay    int64
	WorkerHighQuantileCPUMS int64
	WorkerCount             int64
	PagesBuildsPerMonth     int64
	PagesAssetFiles         int64
	PagesProjectCount       int64
	D1RowsReadPerDay        int64
	D1RowsWrittenPerDay     int64
	D1LargestDatabaseBytes  int64
	D1AccountStorageBytes   int64
	D1DatabaseCount         int64
}

// ApproachingFreeLimit applies the admission threshold to observed usage.
// Empty observations are zero; operators should keep the emergency pause
// switch enabled whenever a required monitoring source is unavailable.
func (usage FreeQuotaUsage) ApproachingFreeLimit() bool {
	return atFreeQuotaThreshold(usage.WorkerRequestsPerDay, 100_000) ||
		atFreeQuotaThreshold(usage.WorkerHighQuantileCPUMS, 10) ||
		atFreeQuotaThreshold(usage.WorkerCount, 100) ||
		atFreeQuotaThreshold(usage.PagesBuildsPerMonth, 500) ||
		atFreeQuotaThreshold(usage.PagesAssetFiles, 20_000) ||
		atFreeQuotaThreshold(usage.PagesProjectCount, 100) ||
		atFreeQuotaThresholdPercent(usage.D1RowsReadPerDay, 5_000_000, freeQuotaD1ReadAdmissionThresholdPercent) ||
		atFreeQuotaThreshold(usage.D1RowsWrittenPerDay, 100_000) ||
		atFreeQuotaThreshold(usage.D1LargestDatabaseBytes, 500_000_000) ||
		atFreeQuotaThreshold(usage.D1AccountStorageBytes, 5_000_000_000) ||
		atFreeQuotaThreshold(usage.D1DatabaseCount, 10)
}

func atFreeQuotaThreshold(usage, limit int64) bool {
	return atFreeQuotaThresholdPercent(usage, limit, freeQuotaAdmissionThresholdPercent)
}

func atFreeQuotaThresholdPercent(usage, limit, thresholdPercent int64) bool {
	if usage < 0 || limit <= 0 {
		return true
	}
	threshold := (limit*thresholdPercent + 99) / 100
	return usage >= threshold
}

// QuotaSnapshotIsCurrent reports whether the measured snapshot is from the
// current UTC day and no more than three hours old.
func QuotaSnapshotIsCurrent(measuredAt string, now time.Time) bool {
	parsed, err := time.Parse(time.RFC3339, measuredAt)
	if err != nil {
		return false
	}
	now = now.UTC()
	parsed = parsed.UTC()
	age := now.Sub(parsed)
	return age >= 0 && age <= quotaSnapshotMaximumAge && parsed.Format("2006-01-02") == now.Format("2006-01-02")
}
