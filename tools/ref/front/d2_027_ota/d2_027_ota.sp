.subckt d2_027_ota vdd vss inp inn o2 id
M1 id id vss vss nmos_lvt w=1680e-9 l=150e-9 nf=12
M2 tail id vss vss nmos_lvt w=1680e-9 l=150e-9 nf=12
M3 o1 inp tail vss nmos_lvt w=1260e-9 l=150e-9 nf=10
M4 o2 inn tail vss nmos_lvt w=1260e-9 l=150e-9 nf=10
M5 o1 o1 vdd vdd pmos_lvt w=630e-9 l=150e-9 nf=6
M6 o2 o1 vdd vdd pmos_lvt w=630e-9 l=150e-9 nf=6
.ends d2_027_ota
