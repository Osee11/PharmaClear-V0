#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>

#define PORT 8080
#define QUEUE_DIR "./queue"

int main() {
    printf("[PharmaClear C Server] Simulation clinique locale\n");
    printf("Mode: Mini-PC sans internet - Port %d\n", PORT);
    
    // Crée dossier file d'attente
    system("mkdir -p " QUEUE_DIR);

    int server_fd, new_socket;
    struct sockaddr_in address;
    int opt = 1;
    
    server_fd = socket(AF_INET, SOCK_STREAM, 0);
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = INADDR_ANY;
    address.sin_port = htons(PORT);
    
    bind(server_fd, (struct sockaddr*)&address, sizeof(address));
    listen(server_fd, 3);
    
    printf("En attente d'ordonnances de l'infirmier sur 127.0.0.1:%d...\n", PORT);

    while(1) {
        new_socket = accept(server_fd, NULL, NULL);
        char buffer[1024] = {0};
        read(new_socket, buffer, 1024);
        
        // Simule sauvegarde file d'attente
        printf("-> Nouvelle ordonnance reçue. Mise en file d'attente dans %s/\n", QUEUE_DIR);
        char *response = "HTTP/1.1 200 OK\nContent-Type: text/plain\n\n[PharmaClear C] Ordonnance mise en file. En attente d'internet pour sync vers Cloud Node.js (port 3000).";
        send(new_socket, response, strlen(response), 0);
        close(new_socket);
    }
    return 0;
}