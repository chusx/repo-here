# Guest OS for the in-browser shell: 32-bit Alpine Linux (v86 emulates i686).
FROM docker.io/i386/alpine:3.21

RUN apk add --no-cache \
      linux-virt linux-firmware-none mkinitfs agetty util-linux-misc \
      bash bash-completion coreutils findutils grep sed gawk diffutils patch \
      less file tree ncurses procps-ng psmisc htop \
      vim nano jq bc tar gzip xz bzip2 zip unzip \
      python3 git sqlite ripgrep fd make xxd man-pages \
 && sed -i 's#^root:.*#root::0:0:root:/root:/bin/bash#' /etc/passwd \
 && echo webshell > /etc/hostname \
 && mkinitfs -F "base virtio 9p" "$(cat /usr/share/kernel/virt/kernel.release)"

COPY rootfs/ /
RUN chmod +x /sbin/webshell-init /usr/local/bin/* \
 && mkdir -p /var/host-outbox /mnt \
 && rm -rf /var/cache/apk/* /usr/share/apk
