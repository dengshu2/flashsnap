// Command flashsnap serves FlashSnap, which turns text into information cards.
//
//	flashsnap                          run the server
//	flashsnap health                   exit 0 if the local server answers (for the container health check)
//	flashsnap user add <email>         create an account, or reset its password (read from stdin)
//	flashsnap user import <email> <bcrypt-hash>   create an account with an existing password hash
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/joho/godotenv"

	"flashsnap/internal/api"
	"flashsnap/internal/auth"
	"flashsnap/internal/config"
	"flashsnap/internal/deepseek"
	"flashsnap/internal/prompt"
	"flashsnap/internal/render"
	"flashsnap/internal/store"
	"flashsnap/web"
)

func main() {
	_ = godotenv.Load() // local development only

	if len(os.Args) > 1 && os.Args[1] == "health" {
		port := os.Getenv("PORT")
		if port == "" {
			port = "8080"
		}
		resp, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://127.0.0.1:" + port + "/health")
		if err != nil || resp.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "user" {
		if err := userCommand(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	st, err := store.Open(filepath.Join(cfg.DataDir, "flashsnap.db"))
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer st.Close()
	prompts, err := prompt.Load()
	if err != nil {
		log.Fatalf("prompts: %v", err)
	}
	renderer := render.New(cfg.ChromePath, cfg.RenderConcurrency)
	defer renderer.Close()

	handler := api.Handler(api.Deps{
		Store:    st,
		Auth:     auth.NewService(st, cfg.JWTSecret),
		Model:    deepseek.New(cfg.DeepSeekAPIKey, cfg.DeepSeekModel, cfg.DeepSeekBaseURL),
		Renderer: renderer,
		Prompts:  prompts,
		ImageDir: filepath.Join(cfg.DataDir, "cards"),
		Static:   web.Handler(cfg.UmamiWebsiteID),
	})

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      60 * time.Second, // card streams extend their own deadline
		IdleTimeout:       60 * time.Second,
	}
	go func() {
		log.Printf("flashsnap listening on :%s (model=%s)", cfg.Port, cfg.DeepSeekModel)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

// userCommand manages accounts; there is no sign-up page.
func userCommand(args []string) error {
	usage := errors.New("usage: flashsnap user add <email>  |  flashsnap user import <email> <bcrypt-hash>")
	if len(args) < 2 {
		return usage
	}
	email, ok := auth.ValidEmail(args[1])
	if !ok {
		return fmt.Errorf("invalid email %q", args[1])
	}
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}
	st, err := store.Open(filepath.Join(dataDir, "flashsnap.db"))
	if err != nil {
		return err
	}
	defer st.Close()

	var hash string
	switch {
	case args[0] == "add" && len(args) == 2:
		fmt.Fprint(os.Stderr, "password: ")
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && line == "" {
			return fmt.Errorf("read password: %w", err)
		}
		if hash, err = auth.HashPassword(strings.TrimRight(line, "\r\n")); err != nil {
			return err
		}
	case args[0] == "import" && len(args) == 3:
		hash = args[2]
		if !strings.HasPrefix(hash, "$2") {
			return errors.New("the hash must be a bcrypt hash")
		}
	default:
		return usage
	}

	if _, err := st.CreateUser(email, hash); errors.Is(err, store.ErrEmailTaken) {
		if err := st.SetPassword(email, hash); err != nil {
			return err
		}
		fmt.Fprintln(os.Stderr, "password updated for", email)
		return nil
	} else if err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "created", email)
	return nil
}
