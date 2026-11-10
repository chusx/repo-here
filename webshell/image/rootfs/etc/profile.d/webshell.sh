export LANG=C.UTF-8 EDITOR=vim PAGER=less LESS=-R
if [ -n "$BASH_VERSION" ] && [ -z "$WEBSHELL_GREETED" ] && [ "$(tty)" = /dev/hvc0 ]; then
  export WEBSHELL_GREETED=1
  printf '\033[1mwebshell\033[0m — Alpine Linux running in your browser (v86).\n'
  printf '  Mounted host folders: \033[36m/mnt/<name>\033[0m   (use "Mount folder" or drop a folder on the terminal)\n'
  printf '  \033[36mhostsave\033[0m write VM changes back to mounted folders   \033[36mdownload\033[0m <file>   \033[36mopen\033[0m <file|url>\n\n'
fi
