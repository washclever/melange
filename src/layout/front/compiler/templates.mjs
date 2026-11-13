/** ALIGN 의 원시 소자 틀(template)과 SKY130 모델 — 컴파일러가 회로에서 찾아 묶는 모양들.
 *
 *  아래 글은 고치지 않고 옮겨 왔다 (BSD-3-Clause, THIRD-PARTY.md 참고):
 *    BASIC_TEMPLATE   ALIGN-public  align/config/basic_template.sp
 *    USER_TEMPLATE    ALIGN-public  align/config/user_template.sp
 *    SKY130_MODELS    ALIGN-pdk-sky130  SKY130_PDK/models.sp
 */
export const BASIC_TEMPLATE = `.subckt NMOS_4T  D G S B
* @: Generator(name='MOS')
M1 D G S B NMOS
.ends NMOS_4T

.subckt PMOS_4T  D G S B
* @: Generator(name='MOS')
M1 D G S B PMOS
.ends PMOS_4T

.subckt CAP_2T  PLUS MINUS
* @: Generator(name='cap')
C1  PLUS MINUS 1f
.ends CAP_2T

.subckt RES_2T  PLUS MINUS
* @: Generator(name='res')
R1  PLUS MINUS 10k
.ends RES_2T

.subckt NMOS_S  D G S
* @: Generator(name='MOS')
M1 D G S S NMOS w=w1 l=l1
.ends NMOS_S

.subckt PMOS_S D G S
* @: Generator(name='MOS')
M1 D G S S PMOS w=w1 l=l1
.ends PMOS_S

.subckt NMOS_G  D G S
* @: Generator(name='MOS')
M1 D G S G NMOS w=w1 l=l1
.ends NMOS_G

.subckt PMOS_G D G S
* @: Generator(name='MOS')
M1 D G S G PMOS w=w1 l=l1
.ends PMOS_G

.subckt DUMMY_NMOS_S D S
* @: Generator(name='MOS')
M1 D S S S NMOS w=w l=90n
.ends DUMMY_NMOS_S

.subckt DUMMY_PMOS_S D S
* @: Generator(name='MOS')
M1 D S S S PMOS w=w l=90n
.ends DUMMY_PMOS_S

.subckt DCAP_NMOS_B G S B
* @: Generator(name='MOS')
M1 S G S B NMOS w=w l=90n
.ends DCAP_NMOS_B

.subckt DCAP_PMOS_B G S B
* @: Generator(name='MOS')
M1 S G S B PMOS w=w l=90n
.ends DCAP_PMOS_B

.subckt DCAP_NMOS G S
* @: Generator(name='MOS')
M1 S G S S NMOS w=w l=90n
.ends DCAP_NMOS

.subckt DCAP_PMOS G S
* @: Generator(name='MOS')
M1 S G S S PMOS w=w l=90n
.ends DCAP_PMOS

.subckt DCL_NMOS D S B
* @: Generator(name='MOS')
M1 D D S B NMOS w=w l=90n
.ends DCL_NMOS

.subckt DCL_PMOS D S B
* @: Generator(name='MOS')
M1 D D S B PMOS w=w l=90n
.ends DCL_PMOS

.subckt DCL_NMOS_S D S
* @: Generator(name='MOS')
M1 D D S S NMOS w=w l=90n
.ends DCL_NMOS_S

.subckt DCL_PMOS_S D S
* @: Generator(name='MOS')
M1 D D S S PMOS w=w l=90n
.ends DCL_PMOS_S

.subckt DUMMY_NMOS D S B
* @: Generator(name='MOS')
M1 D S S B NMOS w=w l=90n
.ends DUMMY_NMOS

.subckt DUMMY_PMOS D S B
* @: Generator(name='MOS')
M1 D S S B PMOS w=w l=90n
.ends DUMMY_PMOS

.subckt DUMMY1_NMOS S B
* @: Generator(name='MOS')
M1 S S S B NMOS w=w l=90n
.ends DUMMY1_NMOS

.subckt DUMMY1_PMOS S B
* @: Generator(name='MOS')
M1 S S S B PMOS w=w l=90n
.ends DUMMY1_PMOS

.subckt DUMMY1_NMOS_S S
* @: Generator(name='MOS')
M1 S S S S NMOS w=w l=90n
.ends DUMMY1_NMOS_S

.subckt DUMMY1_PMOS_S S
* @: Generator(name='MOS')
M1 S S S S PMOS w=w l=90n
.ends DUMMY1_PMOS_S

.subckt SCM_NMOS_B DA DB S B
* @: Generator(name='MOS')
M1 DA DA S B NMOS w=w l=90n
M2 DB DA S B NMOS w=w l=90n
.ends SCM_NMOS_B

.subckt SCM_PMOS_B DA DB S B
* @: Generator(name='MOS')
M1 DA DA S B PMOS w=w l=90n
M2 DB DA S B PMOS w=w l=90n
.ends SCM_PMOS_B

.subckt SCM_NMOS DA DB S
* @: Generator(name='MOS')
M1 DA DA S S NMOS w=w l=90n
M2 DB DA S S NMOS w=w l=90n
.ends SCM_NMOS

.subckt SCM_PMOS DA DB S
* @: Generator(name='MOS')
M1 DA DA S S PMOS w=w l=90n
M2 DB DA S S PMOS w=w l=90n
.ends SCM_PMOS

.subckt CMC_S_NMOS_B DA DB SA SB G B
* @: Generator(name='MOS', parameters={'pattern':'ncc' , 'parallel_wires':{'DA':1, 'DB':1}})
* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')
* @: SymmetricNets(net1='DA',net2='DB',  direction='V')
* @: SymmetricNets(net1='SA',net2='SB',  direction='V')
M1 DA G SA B NMOS w=w l=90n
M2 DB G SB B NMOS w=w l=90n
.ends CMC_S_NMOS_B

.subckt CMC_S_NMOS DA DB SA SB G
* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')
* @: SymmetricNets(net1='DA',net2='DB',  direction='V')
* @: SymmetricNets(net1='SA',net2='SB',  direction='V')
M1 DA G SA SA NMOS w=w l=90n
M2 DB G SB SB NMOS w=w l=90n
.ends CMC_S_NMOS

.subckt CMC_S_PMOS_B DA DB SA SB G B
* @: Generator(name='MOS')
* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')
* @: SymmetricNets(net1='DA',net2='DB',  direction='V')
* @: SymmetricNets(net1='SA',net2='SB',  direction='V')
M1 DA G SA B PMOS w=w l=90n
M2 DB G SB B PMOS w=w l=90n
.ends CMC_S_PMOS_B

.subckt CMC_NMOS  DA DB G S
* @: Generator(name='MOS')
* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')
* @: SymmetricNets(net1='DA',net2='DB',  direction='V')
* @: SymmetricNets(net1='S',net2='S',  direction='V')
M1 DA G S S NMOS w=w l=90n
M2 DB G S S NMOS w=w l=90n
.ends CMC_NMOS

.subckt CMC_PMOS  DA DB G S
* @: Generator(name='MOS')
* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')
* @: SymmetricNets(net1='DA',net2='DB',  direction='V')
* @: SymmetricNets(net1='S',net2='S',  direction='V')
M1 DA G S S PMOS w=w l=90n
M2 DB G S S PMOS w=w l=90n
.ends CMC_PMOS

.subckt CMC_NMOS_B  DA DB G S B
* @: Generator(name='MOS')
* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')
* @: SymmetricNets(net1='DA',net2='DB',  direction='V')
* @: SymmetricNets(net1='S',net2='S',  direction='V')
M1 DA G S B NMOS w=w l=90n
M2 DB G S B NMOS w=w l=90n
.ends CMC_NMOS_B

.subckt CMC_S_PMOS  DA DB G SA SB
* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')
* @: SymmetricNets(net1='DA',net2='DB',  direction='V')
* @: SymmetricNets(net1='SA',net2='SB',  direction='V')
M1 DA G SA SA PMOS w=w l=90n
M2 DB G SB SB PMOS w=w l=90n
.ends CMC_S_PMOS

.subckt DP_NMOS_B  DA DB GA GB S B
* @: Generator(name='MOS')
* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')
* @: SymmetricNets(net1='DA',net2='DB',  direction='V')
* @: SymmetricNets(net1='S',net2='S',  direction='V')
M1 DA GA S B NMOS w=w l=90n
M2 DB GB S B NMOS w=w l=90n
.ends DP_NMOS_B

.subckt DP_PMOS_B  DA DB GA GB S B
* @: Generator(name='MOS')
* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')
* @: SymmetricNets(net1='DA',net2='DB',  direction='V')
* @: SymmetricNets(net1='S',net2='S',  direction='V')
M1 DA GA S B PMOS w=w l=90n
M2 DB GB S B PMOS w=w l=90n
.ends DP_PMOS_B

.subckt DP_NMOS  DA DB GA GB S
* @: Generator(name='MOS')
* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')
* @: SymmetricNets(net1='DA',net2='DB',  direction='V')
* @: SymmetricNets(net1='S',net2='S',  direction='V')
M1 DA GA S S NMOS w=w l=90n
M2 DB GB S S NMOS w=w l=90n
.ends DP_NMOS

.subckt DP_PMOS  DA DB GA GB S
* @: Generator(name='MOS')
* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')
* @: SymmetricNets(net1='DA',net2='DB',  direction='V')
* @: SymmetricNets(net1='S',net2='S',  direction='V')
M1 DA GA S S PMOS w=w l=90n
M2 DB GB S S PMOS w=w l=90n
.ends DP_PMOS

.subckt CCP_S_NMOS_B DA DB SA SB B
* @: Generator(name='MOS')
* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')
* @: SymmetricNets(net1='DA',net2='DB',  direction='V')
* @: SymmetricNets(net1='SA',net2='SB',  direction='V')
M1 DA DB SA B NMOS w=w l=90n
M2 DB DA SB B NMOS w=w l=90n
.ends CCP_NMOS_B

.subckt CCP_S_PMOS_B DA DB SA SB B
* @: Generator(name='MOS')
* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')
* @: SymmetricNets(net1='DA',net2='DB',  direction='V')
* @: SymmetricNets(net1='SA',net2='SB',  direction='V')
M1 DA DB SA B PMOS w=w l=90n
M2 DB DA SB B PMOS w=w l=90n
.ends CCP_PMOS_B

.subckt CCP_NMOS DA DB S
* @: Generator(name='MOS')
* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')
* @: SymmetricNets(net1='DA',net2='DB',  direction='V')
* @: SymmetricNets(net1='S',net2='S',  direction='V')
M1 DA DB S S NMOS w=w l=90n
M2 DB DA S S NMOS w=w l=90n
.ends CCP_NMOS

.subckt CCP_PMOS DA DB S
* @: Generator(name='MOS')
* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')
* @: SymmetricNets(net1='DA',net2='DB',  direction='V')
* @: SymmetricNets(net1='S',net2='S',  direction='V')
M1 DA DB S S PMOS w=w l=90n
M2 DB DA S S PMOS w=w l=90n
.ends CCP_PMOS

.subckt CCP_NMOS_B DA DB S B
* @: Generator(name='MOS')
* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')
* @: SymmetricNets(net1='DA',net2='DB',  direction='V')
* @: SymmetricNets(net1='S',net2='S',  direction='V')
M1 DA DB S B NMOS w=w l=90n
M2 DB DA S B NMOS w=w l=90n
.ends CCP_NMOS_B

.subckt CCP_PMOS_B DA DB S B
* @: Generator(name='MOS')
* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')
* @: SymmetricNets(net1='DA',net2='DB',  direction='V')
* @: SymmetricNets(net1='S',net2='S',  direction='V')
M1 DA DB S B PMOS w=w l=90n
M2 DB DA S B PMOS w=w l=90n
.ends CCP_PMOS_B

.subckt LS_S_NMOS_B DA DB SA SB B
* @: Generator(name='MOS')
* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')
* @: SymmetricNets(net1='DA',net2='DB',  direction='V')
* @: SymmetricNets(net1='SA',net2='SB',  direction='V')
M1 DA DA SA B NMOS w=w l=90n
M2 DB DA SB B NMOS w=w l=90n
.ends LS_NMOS_B

.subckt LS_S_PMOS_B DA DB SA SB B
* @: Generator(name='MOS')
* @: SymmetricBlocks(pairs=[['M1','M2']], direction='V')
* @: SymmetricNets(net1='DA',net2='DB',  direction='V')
* @: SymmetricNets(net1='SA',net2='SB',  direction='V')
M1 DA DA SA B PMOS w=w l=90n
M2 DB DA SB B PMOS w=w l=90n
.ends LS_S_PMOS_B
`;

export const USER_TEMPLATE = `.subckt CASCODED_CMC_PMOS DA GA DB S
* @: SymmetricBlocks(pairs=[['M0','M1'], ['M2','M3']], direction='V')
M0 DA GA SA S PMOS w=27e-9 l=20e-9 nfin=60
M1 DB GA SB S PMOS w=27e-9 l=20e-9 nfin=60
M2 SA DB S S PMOS w=27e-9 l=20e-9 nfin=10
M3 SB DB S S PMOS w=27e-9 l=20e-9 nfin=10
.ends CASCODED_CMC_PMOS

.subckt CASCODED_CMC_NMOS DA GA DB S
* @: SymmetricBlocks(pairs=[['M0','M1'], ['M2','M3']], direction='V')
M0 DA GA SA S NMOS w=27e-9 l=20e-9 nfin=24
M1 DB GA SB S NMOS w=27e-9 l=20e-9 nfin=24
M2 SA DA S S NMOS w=27e-9 l=20e-9 nfin=30
M3 SB DA S S NMOS w=27e-9 l=20e-9 nfin=30
.ends CASCODED_CMC_NMOS

.subckt CASCODED_SCM_NMOS DA DC GA S
M0 DA GA DB B NMOS w=w l=90n
M1 DB DA S B NMOS w=w l=90n
M2 DC DA S B NMOS w=w l=90n
.ends CASCODED_SCM_NMOS

.subckt CASCODED_SCM_PMOS DA DC GA S
M0 DA GA DB B PMOS w=w l=90n
M1 DB DA S B PMOS w=w l=90n
M2 DC DA S B PMOS w=w l=90n
.ends CASCODED_SCM_PMOS

.subckt CASCODED_CMB_NMOS_2 DA DD DC GA S
M0 DA GA DB B NMOS w=w l=90n
M1 DB DA S B NMOS w=w l=90n
M2 DC DA S B NMOS w=w l=90n
M3 DD DA S B NMOS w=w l=90n
.ends CASCODED_CMB_NMOS_2

.subckt CASCODED_CMB_PMOS_2 DA DC DD GA S
M0 DA GA DB B PMOS w=w l=90n
M1 DB DA S B PMOS w=w l=90n
M2 DC DA S B PMOS w=w l=90n
M3 DD DA S B PMOS w=w l=90n
.ends CASCODED_CMB_PMOS_2

.subckt LSB_NMOS_2 DA DB DC SA SB SC
**UT austin  array VCM5
M0 DA DA SA B NMOS w=w l=90n
M1 DB DA SB B NMOS w=w l=90n
M2 DC DA SC B NMOS w=w l=90n
.ends LSB_NMOS_2

.subckt LSB_NMOS_7 DA DB DC DD DE DF DG DH SA SB SC SD SE SF SG SH
**UT austin  array BUFFER_VREFP2
M0 DA DA SA B NMOS w=w l=90n
M1 DB DA SB B NMOS w=w l=90n
M2 DC DA SC B NMOS w=w l=90n
M3 DD DA SD B NMOS w=w l=90n
M4 DE DA SE B NMOS w=w l=90n
M5 DF DA SF B NMOS w=w l=90n
M6 DG DA SG B NMOS w=w l=90n
M7 DH DA SH B NMOS w=w l=90n
.ends LSB_NMOS_7

.subckt LSB_PMOS_2 DA DB DC SA SB SC
**UT austin  array VCM5
M0 DA DA SA B PMOS w=w l=90n
M1 DB DA SB B PMOS w=w l=90n
M2 DC DA SC B PMOS w=w l=90n
.ends LSB_PMOS_2

.subckt DP_PAIR_PMOS DA DB DC DD GB S
*UT austin VCM5
* @: SymmetricBlocks(pairs=[['M0','M1'], ['M2','M3']], direction='V')
M0 DC DC S B PMOS w=w l=90n
M1 DA DC S B PMOS w=w l=90n
M2 DB GB S B PMOS w=w l=90n
M3 DD GB S B PMOS w=w l=90n
.ends DP_PAIR_PMOS

.subckt CASCODED_CMB_PMOS_3 DA DC DD DE GA S
M0 DA GA DB B PMOS w=w l=90n
M1 DB DA S B PMOS w=w l=90n
M2 DC DA S B PMOS w=w l=90n
M3 DD DA S B PMOS w=w l=90n
M4 DE DA S B PMOS w=w l=90n
.ends CASCODED_CMB_PMOS_3

.subckt CMB_NMOS_2 DA DB DC S
M0 DA DA S S NMOS w=w l=90n
M1 DB DA S S NMOS w=w l=90n
M2 DC DA S S NMOS w=w l=90n
.ends CMB_NMOS_2
*TBF: parser fails in case of space at end of line in .end statement

.subckt CMB_PMOS_2 DA DB DC S
M0 DA DA S S PMOS w=w l=90n
M1 DB DA S S PMOS w=w l=90n
M2 DC DA S S PMOS w=w l=90n
.ends CMB_PMOS_2

.subckt CMB_NMOS_3 DA DB DC DD S
M0 DA DA S S NMOS w=w l=90n
M1 DB DA S S NMOS w=w l=90n
M2 DC DA S S NMOS w=w l=90n
M3 DD DA S S NMOS w=w l=90n
.ends CMB_NMOS_3

.subckt CMB_PMOS_3 DA DB DC DD S
M0 DA DA S S PMOS w=w l=90n
M1 DB DA S S PMOS w=w l=90n
M2 DC DA S S PMOS w=w l=90n
M3 DD DA S S PMOS w=w l=90n
.ends CMB_PMOS_3

.subckt CMB_NMOS_4 DA DB DC DD DE S
M0 DA DA S S NMOS w=w l=90n
M1 DB DA S S NMOS w=w l=90n
M2 DC DA S S NMOS w=w l=90n
M3 DD DA S S NMOS w=w l=90n
M4 DE DA S S NMOS w=w l=90n
.ends CMB_NMOS_4

.subckt CMB_PMOS_4 DA DB DC DD DE S
M0 DA DA S S PMOS w=w l=90n
M1 DB DA S S PMOS w=w l=90n
M2 DC DA S S PMOS w=w l=90n
M3 DD DA S S PMOS w=w l=90n
M4 DE DA S S PMOS w=w l=90n
.ends CMB_PMOS_4

.subckt INV i zn SN SP
* @: SymmetricBlocks(pairs=[['M0'], ['M1']], direction='V')
M0 zn i SN SN NMOS w=w0 l=l0
M1 zn i SP SP PMOS w=w1 l=l0
.ends INV

.subckt INV_B i zn SN SP PB
* @: SymmetricBlocks(pairs=[['M0'], ['M1']], direction='V')
M0 zn i SN SN NMOS w=w0 l=l0
M1 zn i SP PB PMOS w=w1 l=l0
.ends INV_B

.subckt stage2_inv VI VO SN SP
* @: SymmetricBlocks(pairs=[['M0'], ['M1']], direction='V')
* @: SymmetricBlocks(pairs=[['M2'], ['M3']], direction='V')
M0 VM VI SN SN NMOS l=60n w=1u
M1 VM VI SP SP PMOS l=60n w=1u
M2 VO VM SN SN NMOS l=60n w=1u
M3 VO VM SP SP PMOS l=60n w=1u
.ends stage2_inv
*TBF: had to remove m=1 because in base model m=1 is not there. How to allow user to change base model?

* .subckt spiral_ind PLUS MINUS BULK CTAP
* L0 PLUS MINUS BULK CTAP spiral_sym_ct_mu_z w=9u
* .ends spiral_ind
*TBF: Multi pin inverter

.subckt switched_capacitor_combination Vin agnd Vin_ota Voutn phi1 phi2
m0 Voutn phi1 net67 vss NMOS w=270e-9 l=20e-9 nfin=5
m7 Vin_ota phi1 net63 vss NMOS w=270e-9 l=20e-9 nfin=5
m6 net72 phi1 Vin vss NMOS w=270e-9 l=20e-9 nfin=5
m3 agnd phi2 net67 vss NMOS w=270e-9 l=20e-9 nfin=5
m5 agnd phi2 net63 vss NMOS w=270e-9 l=20e-9 nfin=5
m4 net72 phi2 agnd vss NMOS w=270e-9 l=20e-9 nfin=5
c3 Vin_ota Voutn 60e-15
c1 net63 net67 30e-15
c0 net72 net63 60e-15
.ends switched_capacitor_combination

.subckt tgate GA GB D S BN BP
M0 D GA S BN NMOS w=w l=90n
M1 D GB S BP PMOS w=w l=90n
.ends tgate

.subckt SCM_NMOS_C DA DB S
M0 DA DA S B NMOS w=w l=90n
M1 DB DA S B NMOS w=w l=90n
C0 DA S 1f
.ends SCM_NMOS_C

.subckt SCM_PMOS_C DA DB S
M0 DA DA S B PMOS w=w l=90n
M1 DB DA S B PMOS w=w l=90n
C0 DA S 1f
.ends SCM_PMOS_C

.subckt SCM_NMOS_RC DA DB S
M0 DA DA S B NMOS w=w l=90n
M1 DB GB S B NMOS w=w l=90n
C0 GB S 1f
R0 GB DA 1k
.ends SCM_NMOS_RC

.subckt SCM_PMOS_RC DA DB GA S
M0 DA GA S B NMOS w=w l=90n
M1 DB GB S B NMOS w=w l=90n
C0 GB S 1f
R0 GB DA 1k
C1 DA net1 1f
R1 net1 GA 1k
.ends SCM_NMOS_RC
`;

export const SKY130_MODELS = `.model sky130_fd_pr__pfet_01v8 pmos w=1 l=1 nf=1 m=1 mult=1
.model sky130_fd_pr__nfet_01v8 nmos w=1 l=1 nf=1 m=1 mult=1
.model sky130_fd_pr__pfet_01v8_lvt pmos w=1 l=1 nf=1 m=1 mult=1
.model sky130_fd_pr__nfet_01v8_lvt nmos w=1 l=1 nf=1 m=1 mult=1
.model sky130_fd_pr__pfet_01v8_hvt pmos w=1 l=1 nf=1 m=1 mult=1
.model sky130_fd_pr__nfet_01v8_hvt nmos w=1 l=1 nf=1 m=1 mult=1
.model sky130_fd_pr__pfet_g5v0d10v5 pmos w=1 l=1 nf=1 m=1 mult=1
.model sky130_fd_pr__nfet_g5v0d10v5 nmos w=1 l=1 nf=1 m=1 mult=1
.model nmos_rvt nmos l=1 w=1 nfin=1 nf=1 m=1 mult=1 stack=1 parallel=1
.model pmos_rvt pmos l=1 w=1 nfin=1 nf=1 m=1 mult=1 stack=1 parallel=1
.model nmos_lvt nmos l=1 w=1 nfin=1 nf=1 m=1 mult=1 stack=1 parallel=1
.model pmos_lvt pmos l=1 w=1 nfin=1 nf=1 m=1 mult=1 stack=1 parallel=1
.model nmos_hvt nmos l=1 w=1 nfin=1 nf=1 m=1 mult=1 stack=1 parallel=1
.model pmos_hvt pmos l=1 w=1 nfin=1 nf=1 m=1 mult=1 stack=1 parallel=1
.model nfet nmos nfin=1 nf=1 l=1 m=1  stack=1 parallel=1
.model pfet pmos nfin=1 nf=1 l=1 m=1  stack=1 parallel=1
.model resistor res r=1
.model sky130_fd_pr__cap_mim_m3_1 cap l=1 w=1 m=1 mf=1
.model sky130_fd_pr__cap_mim_m3_2 cap l=1 w=1 m=1 mf=1
.model inductor ind ind=1
`;
