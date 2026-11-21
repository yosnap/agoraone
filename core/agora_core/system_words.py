"""Words that name this computer and its parts in messages. On a Mac they read as always («este Mac», «Llavero»);
on any other system, Windows or Linux, they are generic, so nobody reads about a system they do not use."""
import sys

MAC = sys.platform == "darwin"
# «solo en este Mac» is a privacy level: the interface calls it the same way (src/ui/platform.ts).
HERE = "este Mac" if MAC else "este equipo"
# After «el», «del», «al»: «en el Llavero» on a Mac, «en el almacén de secretos del sistema» elsewhere.
KEYSTORE = "Llavero" if MAC else "almacén de secretos del sistema"
SYSTEM_VOICE = "la voz de macOS" if MAC else "la voz del sistema"
