/*
 * PharmaClear - Serveur relais (C)
 * ---------------------------------------------------------------
 * Rôle : point d'entrée "clinique / pharmacie". Il reçoit les photos
 * d'ordonnances, les range sur disque (file d'attente), puis les renvoie
 * au serveur Node.js dès que celui-ci répond. Rien n'est perdu si le
 * réseau ou le programme s'arrête : tout est sur disque.
 *
 * Compilation :
 *   gcc -Wall -Wextra -O2 -pthread -o serveur serveur.c
 *
 * Lancement :
 *   ./serveur                # port 8080
 *   ./serveur 9000           # autre port
 *
 * Variables d'environnement (toutes optionnelles) :
 *   NODE_URL      URL du serveur Node   (défaut http://127.0.0.1:3000/api/analyze)
 *   PHARMA_TOKEN  si défini, toutes les requêtes doivent envoyer l'en-tête
 *                 "X-Token: <valeur>" (sauf /health et OPTIONS)
 *   PHARMA_BIND   adresse d'écoute (défaut 0.0.0.0 ; mettre 127.0.0.1 pour
 *                 n'accepter que ce PC)
 *
 * Routes :
 *   POST /upload      corps = octets bruts de l'image (jpeg/png/webp, 5 Mo max)
 *                     -> 202 {"id":"...","status":"queued"}
 *   GET  /status/<id> -> {"status":"queued"} ou {"status":"done","result":{...}}
 *   GET  /health      -> {"ok":true}
 *   OPTIONS *         -> 204 (pré-vérification CORS du navigateur)
 *
 * Dossiers créés automatiquement :
 *   queue/    photos en attente d'envoi
 *   done/     photos déjà traitées
 *   results/  réponses JSON de Node (une par photo)
 *
 * Limites connues (à assumer, c'est un prototype) : un seul client est
 * servi à la fois (avec délais d'attente), pas de HTTPS, et l'envoi vers
 * Node passe par le programme "curl", qui doit être installé.
 */

#define _GNU_SOURCE
#include <arpa/inet.h>
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

#define DEFAULT_PORT       8080
#define MAX_BODY           (5LL * 1024 * 1024) /* 5 Mo par image            */
#define MAX_HEADER         8192                /* taille max des en-têtes    */
#define MAX_RESULT         (512 * 1024)        /* taille max d'un résultat   */
#define IO_TIMEOUT_S       10                  /* délai lecture/écriture     */
#define RETRY_INTERVAL_S   3                   /* pause entre deux relances  */
#define CURL_TIMEOUT_S     60                  /* délai max d'un envoi Node  */

#define QUEUE_DIR   "queue"
#define DONE_DIR    "done"
#define RESULTS_DIR "results"

static volatile sig_atomic_t g_running = 1;
static const char *g_node_url = "http://127.0.0.1:3000/api/analyze";
static const char *g_token = NULL;

static void log_msg(const char *fmt, ...)
{
    char ts[32];
    time_t now = time(NULL);
    struct tm tmv;
    localtime_r(&now, &tmv);
    strftime(ts, sizeof ts, "%H:%M:%S", &tmv);

    printf("[%s] ", ts);
    va_list ap;
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    printf("\n");
    fflush(stdout);
}

static void on_signal(int sig)
{
    (void)sig;
    g_running = 0;
}

static int send_all(int fd, const char *buf, size_t len)
{
    size_t sent = 0;
    while (sent < len) {
        ssize_t n = send(fd, buf + sent, len - sent, MSG_NOSIGNAL);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        sent += (size_t)n;
    }
    return 0;
}

static void send_response(int fd, int code, const char *reason,
                          const char *ctype, const char *body, size_t blen)
{
    char head[640];
    int n = snprintf(head, sizeof head,
                     "HTTP/1.1 %d %s\r\n"
                     "Content-Type: %s\r\n"
                     "Content-Length: %zu\r\n"
                     "Access-Control-Allow-Origin: *\r\n"
                     "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                     "Access-Control-Allow-Headers: Content-Type, X-Token\r\n"
                     "Cache-Control: no-store\r\n"
                     "Connection: close\r\n"
                     "\r\n",
                     code, reason, ctype, blen);
    if (n < 0 || (size_t)n >= sizeof head) return;
    if (send_all(fd, head, (size_t)n) < 0) return;
    if (blen > 0) send_all(fd, body, blen);
}

static void send_json(int fd, int code, const char *reason, const char *json)
{
    send_response(fd, code, reason, "application/json; charset=utf-8",
                  json, strlen(json));
}

/* Un identifiant n'a le droit de contenir que lettres, chiffres, '-' et '_'.
 * Cela empêche toute tentative du type "../../etc/passwd". */
static int valid_id(const char *id)
{
    size_t n = strlen(id);
    if (n == 0 || n > 64) return 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)id[i];
        if (!(isalnum(c) || c == '-' || c == '_')) return 0;
    }
    return 1;
}

static void make_id(char *out, size_t outsz)
{
    static unsigned counter = 0;
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    long long ms = (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
    snprintf(out, outsz, "%lld-%u", ms, counter++ % 1000);
}

static int ensure_dir(const char *path)
{
    if (mkdir(path, 0755) == 0 || errno == EEXIST) return 0;
    fprintf(stderr, "Impossible de créer le dossier %s : %s\n", path,
            strerror(errno));
    return -1;
}

static int file_exists(const char *path)
{
    return access(path, F_OK) == 0;
}

/* Lit un fichier entier en mémoire (NUL-terminé). Renvoie NULL en cas d'échec. */
static char *read_file(const char *path, size_t *len_out, size_t max)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
    long sz = ftell(f);
    if (sz <= 0 || (size_t)sz > max) { fclose(f); return NULL; }
    rewind(f);
    char *buf = malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t n = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[n] = '\0';
    if (len_out) *len_out = n;
    return buf;
}

/* Cherche un en-tête HTTP (insensible à la casse) dans la requête reçue. */
static int header_value(const char *hdrs, const char *name,
                        char *out, size_t outsz)
{
    size_t nlen = strlen(name);
    const char *p = strstr(hdrs, "\r\n"); /* on saute la ligne de requête */
    while (p) {
        p += 2;
        if (p[0] == '\r' && p[1] == '\n') break; /* fin des en-têtes */
        if (strncasecmp(p, name, nlen) == 0 && p[nlen] == ':') {
            p += nlen + 1;
            while (*p == ' ' || *p == '\t') p++;
            const char *e = strstr(p, "\r\n");
            size_t l = e ? (size_t)(e - p) : strlen(p);
            if (l >= outsz) l = outsz - 1;
            memcpy(out, p, l);
            out[l] = '\0';
            while (l > 0 && (out[l - 1] == ' ' || out[l - 1] == '\t'))
                out[--l] = '\0';
            return 1;
        }
        p = strstr(p, "\r\n");
    }
    return 0;
}

/* Vérifie que le contenu ressemble vraiment à l'image annoncée. */
static int magic_ok(const char *path, const char *ext)
{
    unsigned char b[12];
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    size_t n = fread(b, 1, sizeof b, f);
    fclose(f);
    if (n < sizeof b) return 0;
    if (!strcmp(ext, "jpg"))  return b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF;
    if (!strcmp(ext, "png"))  return memcmp(b, "\x89PNG", 4) == 0;
    if (!strcmp(ext, "webp")) return memcmp(b, "RIFF", 4) == 0 &&
                                     memcmp(b + 8, "WEBP", 4) == 0;
    return 0;
}

static const char *ext_from_ctype(const char *ctype)
{
    if (strncasecmp(ctype, "image/jpeg", 10) == 0) return "jpg";
    if (strncasecmp(ctype, "image/png", 9) == 0)   return "png";
    if (strncasecmp(ctype, "image/webp", 10) == 0) return "webp";
    return NULL;
}

static const char *ctype_from_ext(const char *ext)
{
    if (!strcmp(ext, "jpg"))  return "image/jpeg";
    if (!strcmp(ext, "png"))  return "image/png";
    if (!strcmp(ext, "webp")) return "image/webp";
    return NULL;
}

static void handle_upload(int fd, const char *hdrs,
                          const char *body0, size_t have)
{
    char val[128];

    if (!header_value(hdrs, "Content-Length", val, sizeof val)) {
        send_json(fd, 411, "Length Required",
                  "{\"error\":\"Content-Length requis\"}");
        return;
    }
    char *endp = NULL;
    long long clen = strtoll(val, &endp, 10);
    if (endp == val || clen <= 0) {
        send_json(fd, 400, "Bad Request",
                  "{\"error\":\"Content-Length invalide\"}");
        return;
    }
    if (clen > MAX_BODY) {
        send_json(fd, 413, "Payload Too Large",
                  "{\"error\":\"image trop grande (5 Mo max)\"}");
        return;
    }

    if (!header_value(hdrs, "Content-Type", val, sizeof val) ||
        !ext_from_ctype(val)) {
        send_json(fd, 415, "Unsupported Media Type",
                  "{\"error\":\"Content-Type doit etre image/jpeg, image/png ou image/webp\"}");
        return;
    }
    const char *ext = ext_from_ctype(val);

    char id[64];
    make_id(id, sizeof id);

    /* On écrit dans un fichier temporaire (caché), puis on renomme :
     * le renvoi vers Node ne voit jamais une image à moitié reçue. */
    char tmp[256], final[256];
    snprintf(tmp, sizeof tmp, "%s/.tmp-%s", QUEUE_DIR, id);
    snprintf(final, sizeof final, "%s/%s.%s", QUEUE_DIR, id, ext);

    int out = open(tmp, O_WRONLY | O_CREAT | O_EXCL, 0644);
    if (out < 0) {
        log_msg("ERREUR : ouverture %s : %s", tmp, strerror(errno));
        send_json(fd, 500, "Internal Server Error",
                  "{\"error\":\"ecriture impossible\"}");
        return;
    }

    long long remaining = clen;
    int ok = 1;

    /* 1) octets du corps déjà lus avec les en-têtes */
    size_t first = have;
    if ((long long)first > remaining) first = (size_t)remaining;
    if (first > 0) {
        if (write(out, body0, first) != (ssize_t)first) ok = 0;
        remaining -= (long long)first;
    }

    /* 2) le reste, directement depuis la socket */
    char chunk[16384];
    while (ok && remaining > 0) {
        size_t want = remaining < (long long)sizeof chunk
                          ? (size_t)remaining : sizeof chunk;
        ssize_t n = recv(fd, chunk, want, 0);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { ok = 0; break; }
        if (write(out, chunk, (size_t)n) != n) { ok = 0; break; }
        remaining -= n;
    }
    close(out);

    if (!ok || remaining != 0) {
        unlink(tmp);
        log_msg("Upload %s interrompu (reçu incomplet)", id);
        send_json(fd, 400, "Bad Request",
                  "{\"error\":\"envoi incomplet ou trop lent\"}");
        return;
    }

    if (!magic_ok(tmp, ext)) {
        unlink(tmp);
        log_msg("Upload %s refusé : contenu ne ressemble pas à une image %s",
                id, ext);
        send_json(fd, 415, "Unsupported Media Type",
                  "{\"error\":\"le fichier n'est pas une image valide\"}");
        return;
    }

    if (rename(tmp, final) != 0) {
        unlink(tmp);
        log_msg("ERREUR : rename -> %s : %s", final, strerror(errno));
        send_json(fd, 500, "Internal Server Error",
                  "{\"error\":\"ecriture impossible\"}");
        return;
    }

    log_msg("-> Ordonnance %s reçue (%lld octets). Mise en file : %s",
            id, clen, final);

    char resp[160];
    snprintf(resp, sizeof resp, "{\"id\":\"%s\",\"status\":\"queued\"}", id);
    send_json(fd, 202, "Accepted", resp);
}

static void handle_status(int fd, const char *raw_id)
{
    if (!valid_id(raw_id)) {
        send_json(fd, 400, "Bad Request", "{\"error\":\"id invalide\"}");
        return;
    }
    char id[65]; /* valid_id garantit 64 caractères maximum */
    memcpy(id, raw_id, strlen(raw_id) + 1);

    char path[256];
    snprintf(path, sizeof path, "%s/%s.json", RESULTS_DIR, id);
    size_t rlen = 0;
    char *res = read_file(path, &rlen, MAX_RESULT);
    if (res) {
        size_t cap = rlen + 128;
        char *out = malloc(cap);
        if (out) {
            int n = snprintf(out, cap,
                             "{\"id\":\"%s\",\"status\":\"done\",\"result\":%s}",
                             id, res);
            send_response(fd, 200, "OK", "application/json; charset=utf-8",
                          out, (size_t)n);
            free(out);
        } else {
            send_json(fd, 500, "Internal Server Error",
                      "{\"error\":\"memoire insuffisante\"}");
        }
        free(res);
        return;
    }

    static const char *exts[] = {"jpg", "png", "webp"};
    for (size_t i = 0; i < 3; i++) {
        snprintf(path, sizeof path, "%s/%s.%s", QUEUE_DIR, id, exts[i]);
        if (file_exists(path)) {
            char resp[160];
            snprintf(resp, sizeof resp,
                     "{\"id\":\"%s\",\"status\":\"queued\"}", id);
            send_json(fd, 200, "OK", resp);
            return;
        }
    }
    send_json(fd, 404, "Not Found", "{\"status\":\"unknown\"}");
}

static void handle_client(int fd)
{
    struct timeval tv = {IO_TIMEOUT_S, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);

    char buf[MAX_HEADER + 1];
    size_t len = 0;
    char *hend = NULL;

    /* Lecture des en-têtes jusqu'à la ligne vide. */
    while (!hend) {
        if (len >= MAX_HEADER) {
            send_json(fd, 431, "Request Header Fields Too Large",
                      "{\"error\":\"en-tetes trop longs\"}");
            return;
        }
        ssize_t n = recv(fd, buf + len, MAX_HEADER - len, 0);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return; /* client parti ou trop lent */
        len += (size_t)n;
        buf[len] = '\0';
        hend = strstr(buf, "\r\n\r\n");
    }

    const char *body0 = hend + 4;
    size_t have = len - (size_t)(body0 - buf);

    char method[8] = {0}, path[256] = {0};
    if (sscanf(buf, "%7s %255s", method, path) != 2) {
        send_json(fd, 400, "Bad Request", "{\"error\":\"requete invalide\"}");
        return;
    }
    char *q = strchr(path, '?');
    if (q) *q = '\0';

    if (!strcmp(method, "OPTIONS")) {
        send_response(fd, 204, "No Content", "text/plain", "", 0);
        return;
    }

    if (!strcmp(method, "GET") && !strcmp(path, "/health")) {
        send_json(fd, 200, "OK", "{\"ok\":true}");
        return;
    }

    if (g_token) {
        char tok[128] = {0};
        if (!header_value(buf, "X-Token", tok, sizeof tok) ||
            strcmp(tok, g_token) != 0) {
            send_json(fd, 401, "Unauthorized", "{\"error\":\"token invalide\"}");
            return;
        }
    }

    if (!strcmp(method, "POST") && !strcmp(path, "/upload")) {
        handle_upload(fd, buf, body0, have);
    } else if (!strcmp(method, "GET") && !strncmp(path, "/status/", 8)) {
        handle_status(fd, path + 8);
    } else {
        send_json(fd, 404, "Not Found", "{\"error\":\"route inconnue\"}");
    }
}

/* Envoie une photo à Node avec curl. Renvoie 1 si tout s'est bien passé. */
static int forward_one(const char *name)
{
    char id[80];
    const char *dot = strrchr(name, '.');
    if (!dot || dot == name) return 1; /* fichier inattendu : on l'ignore */

    size_t idlen = (size_t)(dot - name);
    if (idlen >= sizeof id) return 1;
    memcpy(id, name, idlen);
    id[idlen] = '\0';
    const char *ext = dot + 1;
    const char *ctype = ctype_from_ext(ext);
    if (!valid_id(id) || !ctype) return 1;

    char src[256], tmp[256], dst[256], donep[256], form[400];
    snprintf(src, sizeof src, "%s/%s", QUEUE_DIR, name);
    snprintf(tmp, sizeof tmp, "%s/.tmp-%s.json", RESULTS_DIR, id);
    snprintf(dst, sizeof dst, "%s/%s.json", RESULTS_DIR, id);
    snprintf(donep, sizeof donep, "%s/%s", DONE_DIR, name);
    snprintf(form, sizeof form, "prescription=@%s;type=%s", src, ctype);

    log_msg("Envoi de %s vers Node...", id);

    pid_t pid = fork();
    if (pid < 0) {
        log_msg("ERREUR : fork : %s", strerror(errno));
        return 0;
    }
    if (pid == 0) {
        /* Processus enfant : on remplace par curl (pas de shell, donc pas
         * d'injection de commande possible). */
        int devnull = open("/dev/null", O_WRONLY);
        if (devnull >= 0) {
            dup2(devnull, STDOUT_FILENO);
            dup2(devnull, STDERR_FILENO);
        }
        char tmo[16];
        snprintf(tmo, sizeof tmo, "%d", CURL_TIMEOUT_S);
        execlp("curl", "curl", "-sS", "-f", "--max-time", tmo,
               "-o", tmp, "-F", form, g_node_url, (char *)NULL);
        _exit(127);
    }

    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}

    int ok = WIFEXITED(status) && WEXITSTATUS(status) == 0;
    if (ok) {
        /* On vérifie que la réponse ressemble à du JSON (objet). */
        size_t rlen = 0;
        char *res = read_file(tmp, &rlen, MAX_RESULT);
        if (!res) {
            ok = 0;
        } else {
            const char *p = res;
            while (*p && isspace((unsigned char)*p)) p++;
            if (*p != '{') ok = 0;
            free(res);
        }
    }

    if (!ok) {
        unlink(tmp);
        if (WIFEXITED(status) && WEXITSTATUS(status) == 127)
            log_msg("curl est introuvable : installe-le (apt install curl)");
        else
            log_msg("Echec de l'envoi de %s (Node ou internet indisponible). "
                    "Nouvelle tentative dans %d s.", id, RETRY_INTERVAL_S);
        return 0;
    }

    if (rename(tmp, dst) != 0) {
        log_msg("ERREUR : rename résultat %s : %s", dst, strerror(errno));
        unlink(tmp);
        return 0;
    }
    if (rename(src, donep) != 0)
        log_msg("Attention : impossible de déplacer %s vers %s/", src, DONE_DIR);

    log_msg("OK Résultat reçu pour %s -> %s", id, dst);
    return 1;
}

static void *forwarder_thread(void *arg)
{
    (void)arg;
    while (g_running) {
        DIR *d = opendir(QUEUE_DIR);
        if (d) {
            struct dirent *e;
            while (g_running && (e = readdir(d)) != NULL) {
                if (e->d_name[0] == '.') continue; /* fichiers temporaires */
                if (!forward_one(e->d_name)) break; /* on réessaiera plus tard */
            }
            closedir(d);
        }
        for (int i = 0; i < RETRY_INTERVAL_S && g_running; i++) sleep(1);
    }
    return NULL;
}

int main(int argc, char **argv)
{
    int port = DEFAULT_PORT;
    if (argc > 1) {
        port = atoi(argv[1]);
        if (port <= 0 || port > 65535) {
            fprintf(stderr, "Port invalide : %s\n", argv[1]);
            return 1;
        }
    }
    if (getenv("NODE_URL") && *getenv("NODE_URL")) g_node_url = getenv("NODE_URL");
    if (getenv("PHARMA_TOKEN") && *getenv("PHARMA_TOKEN"))
        g_token = getenv("PHARMA_TOKEN");
    const char *bind_addr = getenv("PHARMA_BIND");
    if (!bind_addr || !*bind_addr) bind_addr = "0.0.0.0";

    if (ensure_dir(QUEUE_DIR) || ensure_dir(DONE_DIR) || ensure_dir(RESULTS_DIR))
        return 1;

    signal(SIGPIPE, SIG_IGN);
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_signal;
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);

    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0) { perror("socket"); return 1; }
    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof opt);

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    if (inet_pton(AF_INET, bind_addr, &addr.sin_addr) != 1) {
        fprintf(stderr, "Adresse invalide : %s\n", bind_addr);
        return 1;
    }
    if (bind(server_fd, (struct sockaddr *)&addr, sizeof addr) < 0) {
        perror("bind (le port est peut-etre deja utilise)");
        return 1;
    }
    if (listen(server_fd, 16) < 0) { perror("listen"); return 1; }

    printf("=== PharmaClear - Serveur relais C ===\n");
    log_msg("Ecoute sur %s:%d", bind_addr, port);
    log_msg("Envoi vers Node : %s", g_node_url);
    log_msg("Protection par token : %s", g_token ? "oui" : "non");
    if (!strcmp(bind_addr, "0.0.0.0"))
        log_msg("Attention : accessible depuis tout le réseau local. "
                "N'utilise que des ordonnances factices sur un Wi-Fi partagé.");

    pthread_t th;
    if (pthread_create(&th, NULL, forwarder_thread, NULL) != 0) {
        perror("pthread_create");
        return 1;
    }

    while (g_running) {
        /* poll() avec délai d'une seconde : on revérifie g_running même si
         * le signal d'arrêt est tombé sur un autre thread. */
        struct pollfd pfd = {server_fd, POLLIN, 0};
        int pr = poll(&pfd, 1, 1000);
        if (pr <= 0) continue;

        int cfd = accept(server_fd, NULL, NULL);
        if (cfd < 0) {
            if (errno == EINTR) continue;
            perror("accept");
            continue;
        }
        handle_client(cfd);
        close(cfd);
    }

    log_msg("Arret demandé, fermeture...");
    close(server_fd);
    pthread_join(th, NULL);
    log_msg("Serveur arrêté. La file d'attente reste sur disque.");
    return 0;
}