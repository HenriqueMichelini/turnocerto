package schedule

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
)

const (
	PreviewScheduleID  = "preview-fixture"
	maximumNameLength  = 80
	maximumRequestSize = 1024
)

var ErrNotFound = errors.New("schedule not found")
var ErrPlatformQuotaExceeded = errors.New("platform quota exceeded")

type ManagementSpace struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Schedule struct {
	ID              string              `json:"id"`
	Name            string              `json:"name"`
	TimeZone        string              `json:"timeZone"`
	Revision        string              `json:"-"`
	ManagementSpace ManagementSpace     `json:"managementSpace"`
	Participations  []WeekParticipation `json:"participations,omitempty"`
}

type Store interface {
	GetSchedule(context.Context, string) (Schedule, error)
	RenameSchedule(context.Context, string, string) (Schedule, error)
}

type handler struct {
	store              Store
	managementStore    ManagementSpaceStore
	deletionStore      DeletionRecordStore
	managementSecurity ManagementSecurity
	appEnv             string
	webOrigin          string
	previewTokenHash   []byte
}

func NewHTTPHandler(store Store, appEnv, webOrigin, previewTokenHashHex string) http.Handler {
	previewTokenHash, _ := hex.DecodeString(previewTokenHashHex)
	return &handler{store: store, appEnv: appEnv, webOrigin: webOrigin, previewTokenHash: previewTokenHash}
}

func NewHTTPHandlerWithManagement(store Store, managementStore ManagementSpaceStore, appEnv, webOrigin, previewTokenHashHex string, security ManagementSecurity, deletionStores ...DeletionRecordStore) http.Handler {
	previewTokenHash, _ := hex.DecodeString(previewTokenHashHex)
	api := &handler{
		store:              store,
		managementStore:    managementStore,
		managementSecurity: security,
		appEnv:             appEnv,
		webOrigin:          webOrigin,
		previewTokenHash:   previewTokenHash,
	}
	if len(deletionStores) > 0 {
		api.deletionStore = deletionStores[0]
	} else if records, ok := managementStore.(DeletionRecordStore); ok {
		api.deletionStore = records
	}
	return api
}

func (api *handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	setPrivateHeaders(response.Header())
	if origin := request.Header.Get("Origin"); origin != "" {
		if origin != api.webOrigin {
			writeError(response, http.StatusForbidden, "origin_not_allowed")
			return
		}
		setCorsHeaders(response.Header(), origin)
	}

	if request.Method == http.MethodOptions {
		if request.Header.Get("Origin") == "" {
			writeError(response, http.StatusForbidden, "origin_not_allowed")
			return
		}
		response.WriteHeader(http.StatusNoContent)
		return
	}
	if request.URL.Path == managementSpacesPath {
		api.createManagementSpace(response, request)
		return
	}
	if strings.HasPrefix(request.URL.Path, managementSpacesPath+"/") {
		api.managementSpaceRequest(response, request)
		return
	}
	if strings.HasPrefix(request.URL.Path, readLinksPath) {
		api.readLinkRequest(response, request)
		return
	}
	if api.appEnv != "preview" || request.URL.Path != "/api/schedules/"+PreviewScheduleID {
		writeError(response, http.StatusNotFound, "not_found")
		return
	}
	if len(api.previewTokenHash) != sha256.Size {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	if !api.authorized(request.Header.Get("Authorization")) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized")
		return
	}

	switch request.Method {
	case http.MethodGet:
		api.get(response, request)
	case http.MethodPatch:
		api.rename(response, request)
	default:
		response.Header().Set("Allow", "GET, PATCH, OPTIONS")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}

func (api *handler) authorized(authorization string) bool {
	if len(authorization) > 256 {
		return false
	}
	parts := strings.Fields(authorization)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return false
	}
	if len(parts[1]) < 32 || len(parts[1]) > 128 {
		return false
	}
	digest := sha256.Sum256([]byte(parts[1]))
	return subtle.ConstantTimeCompare(digest[:], api.previewTokenHash) == 1
}

func (api *handler) get(response http.ResponseWriter, request *http.Request) {
	schedule, err := api.store.GetSchedule(request.Context(), PreviewScheduleID)
	if err != nil {
		writeStoreError(response, err)
		return
	}
	writeSchedule(response, schedule)
}

func (api *handler) rename(response http.ResponseWriter, request *http.Request) {
	var payload struct {
		Name string `json:"name"`
	}
	if err := decodeJSONBody(request, maximumRequestSize, &payload); err != nil {
		writeJSONBodyError(response, err, "invalid_schedule_name")
		return
	}

	name := strings.TrimSpace(payload.Name)
	if !validName(name) {
		writeError(response, http.StatusBadRequest, "invalid_schedule_name")
		return
	}

	schedule, err := api.store.RenameSchedule(request.Context(), PreviewScheduleID, name)
	if err != nil {
		writeStoreError(response, err)
		return
	}
	writeSchedule(response, schedule)
}

var errUnsupportedJSONMediaType = errors.New("unsupported JSON media type")

func decodeJSONBody(request *http.Request, maximumSize int64, payload any) error {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return errUnsupportedJSONMediaType
	}
	if request.ContentLength > maximumSize {
		return errors.New("JSON body exceeds maximum size")
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, maximumSize+1))
	if err != nil || int64(len(body)) > maximumSize {
		return errors.New("could not read JSON body")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(payload); err != nil {
		return errors.New("invalid JSON body")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("invalid trailing JSON data")
	}
	return nil
}

func writeJSONBodyError(response http.ResponseWriter, err error, invalidBodyCode string) {
	if errors.Is(err, errUnsupportedJSONMediaType) {
		writeError(response, http.StatusUnsupportedMediaType, "unsupported_media_type")
		return
	}
	writeError(response, http.StatusBadRequest, invalidBodyCode)
}

func setPrivateHeaders(headers http.Header) {
	headers.Set("Cache-Control", "private, no-store, max-age=0")
	headers.Set("Content-Type", "application/json; charset=utf-8")
	headers.Set("Expires", "0")
	headers.Set("Pragma", "no-cache")
	headers.Set("Referrer-Policy", "no-referrer")
	headers.Set("X-Content-Type-Options", "nosniff")
	headers.Set("X-Robots-Tag", "noindex, nofollow, noarchive")
}

func setCorsHeaders(headers http.Header, origin string) {
	headers.Set("Access-Control-Allow-Origin", origin)
	headers.Set("Access-Control-Allow-Methods", "GET, PATCH, POST, DELETE, OPTIONS")
	headers.Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type")
	headers.Set("Access-Control-Max-Age", "600")
	headers.Set("Vary", "Origin")
}

func writeStoreError(response http.ResponseWriter, err error) {
	if isPlatformQuotaError(err) {
		writeError(response, http.StatusServiceUnavailable, "platform_quota_exhausted")
		return
	}
	if errors.Is(err, ErrStaleScheduleEdit) {
		writeError(response, http.StatusConflict, "stale_schedule_edit")
		return
	}
	if errors.Is(err, ErrInvalidScheduleWeek) {
		writeError(response, http.StatusBadRequest, "invalid_schedule_week")
		return
	}
	if errors.Is(err, ErrUnauthorized) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized")
		return
	}
	if errors.Is(err, ErrNotFound) {
		writeError(response, http.StatusNotFound, "not_found")
		return
	}
	writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
}

func isPlatformQuotaError(err error) bool {
	if errors.Is(err, ErrPlatformQuotaExceeded) {
		return true
	}
	message := strings.ToLower(err.Error())
	for _, marker := range []string{
		"exceeded d1's free tier daily row read limit",
		"exceeded d1's free tier daily row write limit",
		"exceeded d1's maximum account storage limit",
		"exceeded maximum db size",
	} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

func writeSchedule(response http.ResponseWriter, schedule Schedule) {
	writeJSON(response, http.StatusOK, struct {
		Schedule Schedule `json:"schedule"`
	}{Schedule: schedule})
}

func writeError(response http.ResponseWriter, status int, code string) {
	writeJSON(response, status, struct {
		Error string `json:"error"`
	}{Error: code})
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}
