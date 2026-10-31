#!/bin/bash
# Dê dois cliques para lançar uma nova versão do Nive Atende (gera os instaladores no GitHub).
cd "$(dirname "$0")" || exit 1
echo "== Nova versão do Nive Atende (atual: $(node -p "require('./package.json').version")) =="
echo
echo "  1) Correção      (ex.: 0.1.0 -> 0.1.1)"
echo "  2) Novidade      (ex.: 0.1.0 -> 0.2.0)"
echo "  3) Versão grande (ex.: 0.1.0 -> 1.0.0)"
echo
read -r -p "Escolha 1, 2 ou 3: " op
case "$op" in
  1) tipo=patch ;;
  2) tipo=minor ;;
  3) tipo=major ;;
  *) echo "Opção inválida."; read -r -p "Enter para fechar"; exit 1 ;;
esac
npm run release -- "$tipo"
echo
read -r -p "Enter para fechar"
