package bridge

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const removeInvalidAccountConfirmation = "REMOVE_INVALID_ACCOUNT"

func accountRemovalEligibility(file authFile, usageStatus string, now time.Time) (bool, string) {
	switch {
	case file.Disabled:
		return true, "disabled"
	case expired(file.Expired, file.Claims.Exp, now) && file.RefreshToken == "":
		return true, "expired_without_refresh"
	case file.Provider == "codex" && (usageStatus == "http_401" || usageStatus == "http_403"):
		return true, "authorization_rejected"
	default:
		return false, ""
	}
}

func (s *Server) handleRemoveInvalidAccount(w http.ResponseWriter, r *http.Request) {
	var request RemoveAccountRequest
	if err := decodeJSON(r, &request); err != nil || request.Confirm != removeInvalidAccountConfirmation {
		writeError(w, http.StatusBadRequest, "explicit account removal confirmation is required")
		return
	}

	accountID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/desktop/v1/accounts/"), "/remove")
	if !validAccountPublicID(accountID) {
		writeError(w, http.StatusBadRequest, "invalid account id")
		return
	}

	files, err := s.loadAuthFiles()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read accounts")
		return
	}
	var selected *authFile
	for index := range files {
		if accountPublicID(files[index].FileName) == accountID {
			selected = &files[index]
			break
		}
	}
	if selected == nil {
		writeError(w, http.StatusNotFound, "account not found")
		return
	}

	eligible, _ := s.currentRemovalEligibility(r.Context(), *selected, time.Now())
	if !eligible {
		writeError(w, http.StatusConflict, "account is not currently eligible for removal")
		return
	}
	if err = s.quarantineAuthFile(*selected, accountID, time.Now()); err != nil {
		if errors.Is(err, errUnsafeAuthFile) {
			writeError(w, http.StatusConflict, "account source is not safe to remove")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to isolate account")
		return
	}
	writeJSON(w, http.StatusOK, RemoveAccountResponse{AccountID: accountID, Status: "removed"})
}

func (s *Server) currentRemovalEligibility(ctx context.Context, file authFile, now time.Time) (bool, string) {
	if eligible, reason := accountRemovalEligibility(file, "not_applicable", now); eligible {
		return eligible, reason
	}
	if file.Provider != "codex" || file.Disabled || file.AccessToken == "" {
		return false, ""
	}
	_, status, _ := s.fetchUsage(ctx, file)
	return accountRemovalEligibility(file, status, now)
}

var errUnsafeAuthFile = errors.New("unsafe auth file")

func (s *Server) quarantineAuthFile(file authFile, accountID string, now time.Time) error {
	if filepath.Base(file.FileName) != file.FileName || strings.ToLower(filepath.Ext(file.FileName)) != ".json" {
		return errUnsafeAuthFile
	}
	authDir := filepath.Clean(s.cfg.AuthDir)
	removedDir := filepath.Clean(s.cfg.RemovedAuthDir)
	if authDir == "." || removedDir == "." || removedDir == authDir || pathInside(removedDir, authDir) {
		return errUnsafeAuthFile
	}
	authDirInfo, err := os.Lstat(authDir)
	if err != nil || authDirInfo.Mode()&os.ModeSymlink != 0 || !authDirInfo.IsDir() {
		return errUnsafeAuthFile
	}
	source := filepath.Join(authDir, file.FileName)
	if filepath.Dir(filepath.Clean(source)) != authDir {
		return errUnsafeAuthFile
	}
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return errUnsafeAuthFile
	}
	if err = ensureRemovalRoot(removedDir); err != nil {
		return err
	}
	batchName := now.UTC().Format("20060102T150405.000000000Z") + "-" + accountID
	batchDir := filepath.Join(removedDir, batchName)
	if err = os.Mkdir(batchDir, 0o700); err != nil {
		if errors.Is(err, os.ErrExist) {
			return errUnsafeAuthFile
		}
		return err
	}
	destination := filepath.Join(batchDir, file.FileName)
	if _, statErr := os.Lstat(destination); statErr == nil || !errors.Is(statErr, os.ErrNotExist) {
		_ = os.Remove(batchDir)
		return errUnsafeAuthFile
	}
	if err = os.Rename(source, destination); err != nil {
		_ = os.Remove(batchDir)
		return err
	}
	if err = os.Chmod(destination, 0o600); err != nil {
		_ = os.Rename(destination, source)
		_ = os.Remove(batchDir)
		return err
	}
	return nil
}

func ensureRemovalRoot(path string) error {
	info, err := os.Lstat(path)
	switch {
	case err == nil:
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return errUnsafeAuthFile
		}
	case errors.Is(err, os.ErrNotExist):
		if err = os.MkdirAll(path, 0o700); err != nil {
			return err
		}
	default:
		return err
	}
	return os.Chmod(path, 0o700)
}

func pathInside(candidate, parent string) bool {
	relative, err := filepath.Rel(parent, candidate)
	if err != nil {
		return true
	}
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator)))
}

func validAccountPublicID(value string) bool {
	if len(value) != 12 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}
