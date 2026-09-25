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
	"unicode/utf8"
)

const (
	PreviewScheduleID  = "preview-fixture"
	maximumNameLength  = 80
	maximumRequestSize = 1024
)

var ErrNotFound = errors.New("schedule not found")

type ManagementSpace struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Schedule struct {
	ID              string          `json:"id"`
	Name            string          `json:"name"`
	ManagementSpace ManagementSpace `json:"managementSpace"`
}

type Store interface {
	GetSchedule(context.Context, string) (Schedule, error)
	RenameSchedule(context.Context, string, string) (Schedule, error)
}

type handler struct {
	store            Store
	appEnv           string
	webOrigin        string
	previewTokenHash []byte
}

func NewHTTPHandler(store Store, appEnv, webOrigin, previewTokenHashHex string) http.Handler {
	previewTokenHash, _ := hex.DecodeString(previewTokenHashHex)
	return &handler{store: store, appEnv: appEnv, webOrigin: webOrigin, previewTokenHash: previewTokenHash}
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
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeError(response, http.StatusUnsupportedMediaType, "unsupported_media_type")
		return
	}
	if request.ContentLength > maximumRequestSize {
		writeError(response, http.StatusBadRequest, "invalid_schedule_name")
		return
	}

	body, err := io.ReadAll(io.LimitReader(request.Body, maximumRequestSize+1))
	if err != nil || len(body) > maximumRequestSize {
		writeError(response, http.StatusBadRequest, "invalid_schedule_name")
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var payload struct {
		Name string `json:"name"`
	}
	if err := decoder.Decode(&payload); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_schedule_name")
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(response, http.StatusBadRequest, "invalid_schedule_name")
		return
	}

	name := strings.TrimSpace(payload.Name)
	if name == "" || utf8.RuneCountInString(name) > maximumNameLength {
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
	headers.Set("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS")
	headers.Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type")
	headers.Set("Access-Control-Max-Age", "600")
	headers.Set("Vary", "Origin")
}

func writeStoreError(response http.ResponseWriter, err error) {
	if errors.Is(err, ErrNotFound) {
		writeError(response, http.StatusNotFound, "not_found")
		return
	}
	writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
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
