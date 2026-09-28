package schedule_test

import (
	"testing"
	"time"

	"github.com/HenriqueMichelini/turnocerto/backend/internal/schedule"
)

func TestFreeQuotaAdmissionThresholdCrossingsUseObservedUsage(t *testing.T) {
	tests := []struct {
		name  string
		usage schedule.FreeQuotaUsage
		want  bool
	}{
		{name: "below all limits", usage: schedule.FreeQuotaUsage{WorkerRequestsPerDay: 79_999, WorkerHighQuantileCPUMS: 7, WorkerCount: 79, PagesBuildsPerMonth: 399, PagesAssetFiles: 15_999, PagesProjectCount: 79, D1RowsReadPerDay: 2_499_999, D1RowsWrittenPerDay: 79_999, D1LargestDatabaseBytes: 399_999_999, D1AccountStorageBytes: 3_999_999_999, D1DatabaseCount: 7}, want: false},
		{name: "worker request threshold", usage: schedule.FreeQuotaUsage{WorkerRequestsPerDay: 80_000}, want: true},
		{name: "worker CPU threshold", usage: schedule.FreeQuotaUsage{WorkerHighQuantileCPUMS: 8}, want: true},
		{name: "worker inventory threshold", usage: schedule.FreeQuotaUsage{WorkerCount: 80}, want: true},
		{name: "Pages build threshold", usage: schedule.FreeQuotaUsage{PagesBuildsPerMonth: 400}, want: true},
		{name: "Pages assets threshold", usage: schedule.FreeQuotaUsage{PagesAssetFiles: 16_000}, want: true},
		{name: "Pages project threshold", usage: schedule.FreeQuotaUsage{PagesProjectCount: 80}, want: true},
		{name: "provisional D1 read threshold stops at half of the Free ceiling", usage: schedule.FreeQuotaUsage{D1RowsReadPerDay: 2_500_000}, want: true},
		{name: "D1 write threshold", usage: schedule.FreeQuotaUsage{D1RowsWrittenPerDay: 80_000}, want: true},
		{name: "largest D1 database threshold", usage: schedule.FreeQuotaUsage{D1LargestDatabaseBytes: 400_000_000}, want: true},
		{name: "D1 account storage threshold", usage: schedule.FreeQuotaUsage{D1AccountStorageBytes: 4_000_000_000}, want: true},
		{name: "D1 database inventory threshold", usage: schedule.FreeQuotaUsage{D1DatabaseCount: 8}, want: true},
		{name: "invalid negative measurement fails closed", usage: schedule.FreeQuotaUsage{D1RowsWrittenPerDay: -1}, want: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := test.usage.ApproachingFreeLimit(); got != test.want {
				t.Fatalf("ApproachingFreeLimit() = %t, want %t for observed usage %#v", got, test.want, test.usage)
			}
		})
	}
}

func TestQuotaSnapshotsMustBeCurrentInUTC(t *testing.T) {
	now := time.Date(2026, time.September, 26, 12, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name      string
		measured  string
		wantFresh bool
	}{
		{name: "recent snapshot", measured: "2026-09-26T10:00:00Z", wantFresh: true},
		{name: "snapshot at three hour boundary", measured: "2026-09-26T09:00:00Z", wantFresh: true},
		{name: "snapshot older than three hours", measured: "2026-09-26T08:59:59Z", wantFresh: false},
		{name: "previous UTC day", measured: "2026-09-25T23:59:59Z", wantFresh: false},
		{name: "future snapshot", measured: "2026-09-26T12:00:01Z", wantFresh: false},
		{name: "invalid timestamp", measured: "not-a-time", wantFresh: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := schedule.QuotaSnapshotIsCurrent(test.measured, now); got != test.wantFresh {
				t.Fatalf("QuotaSnapshotIsCurrent(%q) = %t, want %t", test.measured, got, test.wantFresh)
			}
		})
	}
}
